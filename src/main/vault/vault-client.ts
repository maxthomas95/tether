import { net } from 'electron';
import {
  KvReadResult,
  OidcAuthUrlResponse,
  OidcCallbackResponse,
  VaultError,
} from './vault-types';

export interface VaultClientOptions {
  addr: string;
  namespace?: string;
  token?: string;
}

interface VaultErrorEnvelope {
  errors?: string[];
}

/**
 * Thin HTTP wrapper around the HashiCorp Vault REST API.
 *
 * Only implements the surface Tether actually needs:
 *  - OIDC auth method: oidc/auth_url, oidc/callback
 *  - KV v2 read
 *  - KV v2 write (used by the migration helper)
 *  - KV v2 list (used by the path picker)
 *  - token lookup-self (used to fetch the caller's identity post-login)
 *
 * No caching, no retries — callers handle those concerns.
 */
export class VaultClient {
  private readonly addr: string;
  private readonly namespace: string | undefined;
  private token: string | undefined;

  constructor(opts: VaultClientOptions) {
    this.addr = opts.addr.replace(/\/+$/, '');
    this.namespace = opts.namespace || undefined;
    this.token = opts.token;
  }

  setToken(token: string | undefined): void {
    this.token = token;
  }

  hasToken(): boolean {
    return !!this.token;
  }

  async oidcAuthUrl(role: string, redirectUri: string): Promise<OidcAuthUrlResponse> {
    const body = await this.request<{ data?: { auth_url?: string } }>(
      'POST',
      '/v1/auth/oidc/oidc/auth_url',
      { role, redirect_uri: redirectUri },
      { authenticated: false },
    );
    const url = body?.data?.auth_url;
    if (!url) throw new VaultError('Vault OIDC auth_url response missing auth_url field');
    return { auth_url: url };
  }

  async oidcCallback(state: string, code: string, idToken?: string): Promise<OidcCallbackResponse> {
    const params = new URLSearchParams({ state, code });
    if (idToken) params.set('id_token', idToken);
    const body = await this.request<{
      auth?: { client_token?: string; lease_duration?: number; metadata?: Record<string, string> };
    }>(
      'GET',
      `/v1/auth/oidc/oidc/callback?${params.toString()}`,
      undefined,
      { authenticated: false },
    );
    const token = body?.auth?.client_token;
    if (!token) throw new VaultError('Vault OIDC callback response missing client_token');
    return {
      client_token: token,
      ttl_seconds: body.auth?.lease_duration ?? 0,
      identity: body.auth?.metadata?.username || body.auth?.metadata?.email,
    };
  }

  async lookupSelf(): Promise<{ ttl: number; identity?: string; expiresAt?: string }> {
    const body = await this.request<{
      data?: { ttl?: number; expire_time?: string; meta?: Record<string, string>; display_name?: string };
    }>('GET', '/v1/auth/token/lookup-self');
    const data = body?.data ?? {};
    return {
      ttl: data.ttl ?? 0,
      identity: data.meta?.username || data.meta?.email || data.display_name,
      expiresAt: data.expire_time,
    };
  }

  /**
   * KV v2 read. `mount` is the kv-v2 mount (e.g. "secret"), `path` is the
   * logical path (e.g. "tether/ssh/prod"). Internally rewritten to
   * `<mount>/data/<path>`.
   */
  async kvRead(mount: string, path: string): Promise<KvReadResult> {
    const cleanMount = mount.replace(/^\/+|\/+$/g, '');
    const cleanPath = path.replace(/^\/+|\/+$/g, '');
    const body = await this.request<{ data?: { data?: Record<string, unknown>; metadata?: Record<string, unknown> } }>(
      'GET',
      `/v1/${cleanMount}/data/${cleanPath}`,
    );
    return {
      data: body?.data?.data ?? {},
      metadata: body?.data?.metadata,
    };
  }

  /**
   * KV v2 write. Wraps the value object in `{ data: ... }` per the v2 protocol.
   */
  async kvWrite(mount: string, path: string, data: Record<string, unknown>): Promise<void> {
    const cleanMount = mount.replace(/^\/+|\/+$/g, '');
    const cleanPath = path.replace(/^\/+|\/+$/g, '');
    await this.request('POST', `/v1/${cleanMount}/data/${cleanPath}`, { data });
  }

  /**
   * KV v2 list — returns the immediate children at a given path.
   * Empty array if the path has no children or doesn't exist.
   */
  async kvList(mount: string, path: string): Promise<string[]> {
    const cleanMount = mount.replace(/^\/+|\/+$/g, '');
    const cleanPath = path.replace(/^\/+|\/+$/g, '');
    try {
      const body = await this.request<{ data?: { keys?: string[] } }>(
        'LIST',
        `/v1/${cleanMount}/metadata/${cleanPath}`,
      );
      return body?.data?.keys ?? [];
    } catch (err) {
      if (err instanceof VaultError && err.statusCode === 404) return [];
      throw err;
    }
  }

  // ---- internal ----

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    opts: { authenticated?: boolean } = {},
  ): Promise<T> {
    const authenticated = opts.authenticated ?? true;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.namespace) headers['X-Vault-Namespace'] = this.namespace;
    if (authenticated) {
      if (!this.token) throw new VaultError('Not logged in to Vault');
      headers['X-Vault-Token'] = this.token;
    }

    let response: Response;
    try {
      response = await net.fetch(`${this.addr}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new VaultError(
        `Failed to reach Vault at ${this.addr}: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        err,
      );
    }

    // 204 No Content (e.g. KV v2 write) — nothing to parse
    if (response.status === 204) return undefined as T;

    let parsed: unknown = undefined;
    const text = await response.text();
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // fall through — Vault always returns JSON on success, so a parse failure is itself an error
      }
    }

    if (!response.ok) {
      const envelope = parsed as VaultErrorEnvelope | undefined;
      const detail = envelope?.errors?.join('; ') || text || response.statusText;
      throw new VaultError(`Vault ${method} ${path} failed (${response.status}): ${detail}`, response.status);
    }

    return parsed as T;
  }
}
