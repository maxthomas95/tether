import { safeStorage, shell } from 'electron';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { getDb, saveDb } from '../db/database';
import type { VaultConfig, VaultStatus } from '../../shared/types';
import { VaultClient } from './vault-client';
import { VaultError } from './vault-types';

// Vault CLI uses 8250 by default — match it so the same OIDC role's redirect_uris work
const DEFAULT_CALLBACK_PORT = 8250;
const DEFAULT_CALLBACK_PATH = '/oidc/callback';

const CONFIG_KEYS = {
  enabled: 'vaultEnabled',
  addr: 'vaultAddr',
  role: 'vaultRole',
  mount: 'vaultMount',
  namespace: 'vaultNamespace',
  token: 'vaultToken',
  expiresAt: 'vaultTokenExpiresAt',
  identity: 'vaultIdentity',
} as const;

export const DEFAULT_VAULT_CONFIG: VaultConfig = {
  enabled: false,
  addr: '',
  role: '',
  mount: 'secret',
  namespace: '',
};

export function getVaultConfig(): VaultConfig {
  const cfg = getDb().config;
  return {
    enabled: cfg[CONFIG_KEYS.enabled] === 'true',
    addr: cfg[CONFIG_KEYS.addr] || '',
    role: cfg[CONFIG_KEYS.role] || '',
    mount: cfg[CONFIG_KEYS.mount] || 'secret',
    namespace: cfg[CONFIG_KEYS.namespace] || '',
  };
}

export function setVaultConfig(config: VaultConfig): void {
  const cfg = getDb().config;
  cfg[CONFIG_KEYS.enabled] = config.enabled ? 'true' : 'false';
  cfg[CONFIG_KEYS.addr] = config.addr;
  cfg[CONFIG_KEYS.role] = config.role;
  cfg[CONFIG_KEYS.mount] = config.mount;
  cfg[CONFIG_KEYS.namespace] = config.namespace || '';
  saveDb();
}

export function getCachedToken(): { token: string; expiresAt?: string; identity?: string } | null {
  const cfg = getDb().config;
  const enc = cfg[CONFIG_KEYS.token];
  if (!enc) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const token = safeStorage.decryptString(Buffer.from(enc, 'base64'));
    return {
      token,
      expiresAt: cfg[CONFIG_KEYS.expiresAt] || undefined,
      identity: cfg[CONFIG_KEYS.identity] || undefined,
    };
  } catch {
    return null;
  }
}

export function setCachedToken(token: string, expiresAt?: string, identity?: string): void {
  const cfg = getDb().config;
  if (!safeStorage.isEncryptionAvailable()) {
    throw new VaultError('OS keychain (Electron safeStorage) is not available — cannot cache Vault token');
  }
  cfg[CONFIG_KEYS.token] = safeStorage.encryptString(token).toString('base64');
  if (expiresAt) cfg[CONFIG_KEYS.expiresAt] = expiresAt;
  else delete cfg[CONFIG_KEYS.expiresAt];
  if (identity) cfg[CONFIG_KEYS.identity] = identity;
  else delete cfg[CONFIG_KEYS.identity];
  saveDb();
}

export function clearCachedToken(): void {
  const cfg = getDb().config;
  delete cfg[CONFIG_KEYS.token];
  delete cfg[CONFIG_KEYS.expiresAt];
  delete cfg[CONFIG_KEYS.identity];
  saveDb();
}

/**
 * Build a fresh VaultClient from current config + cached token. Returns null
 * if Vault isn't enabled or hasn't been configured. Throws if a cached token
 * exists but is unreadable.
 */
export function buildClient(): VaultClient | null {
  const config = getVaultConfig();
  if (!config.enabled || !config.addr) return null;
  const client = new VaultClient({
    addr: config.addr,
    namespace: config.namespace || undefined,
  });
  const cached = getCachedToken();
  if (cached) client.setToken(cached.token);
  return client;
}

export function getStatus(): VaultStatus {
  const config = getVaultConfig();
  if (!config.enabled) return { enabled: false, loggedIn: false };
  const cached = getCachedToken();
  if (!cached) return { enabled: true, loggedIn: false };
  // If we have an explicit expiry and it's in the past, treat as logged out
  if (cached.expiresAt) {
    const exp = Date.parse(cached.expiresAt);
    if (Number.isFinite(exp) && exp <= Date.now()) {
      return { enabled: true, loggedIn: false, expiresAt: cached.expiresAt, identity: cached.identity };
    }
  }
  return {
    enabled: true,
    loggedIn: true,
    expiresAt: cached.expiresAt,
    identity: cached.identity,
  };
}

interface CallbackResult {
  state: string;
  code: string;
  idToken?: string;
}

/**
 * Spin up a localhost HTTP server, return its bound URL plus a promise that
 * resolves with the OIDC query params from the first matching request.
 *
 * Resolves on `/oidc/callback?state=...&code=...`. Returns the parsed values.
 * Times out after 5 minutes.
 */
function startCallbackServer(): Promise<{
  redirectUri: string;
  waitForCallback: Promise<CallbackResult>;
  shutdown: () => void;
}> {
  return new Promise((resolveOuter, rejectOuter) => {
    let resolveInner: (v: CallbackResult) => void;
    let rejectInner: (e: Error) => void;
    const waitForCallback = new Promise<CallbackResult>((res, rej) => {
      resolveInner = res;
      rejectInner = rej;
    });

    const server = http.createServer((req, res) => {
      if (!req.url) {
        res.writeHead(400).end('bad request');
        return;
      }
      // Strip the host since req.url is path-only
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== DEFAULT_CALLBACK_PATH) {
        res.writeHead(404).end('not found');
        return;
      }
      const state = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      const idToken = url.searchParams.get('id_token') || undefined;
      if (!state || !code) {
        res.writeHead(400).end('missing state/code');
        rejectInner(new VaultError('OIDC callback missing state or code'));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
        '<!doctype html><html><head><title>Vault login complete</title></head><body style="font-family:sans-serif;padding:2rem;background:#1e1e2e;color:#cdd6f4"><h1>Vault login complete</h1><p>You can close this tab and return to Tether.</p></body></html>',
      );
      resolveInner({ state, code, idToken });
    });

    server.on('error', err => {
      rejectOuter(new VaultError(`Failed to start OIDC callback server: ${err.message}`, undefined, err));
    });

    const timeout = setTimeout(() => {
      rejectInner(new VaultError('OIDC login timed out after 5 minutes'));
    }, 5 * 60 * 1000);

    server.listen(DEFAULT_CALLBACK_PORT, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      const port = addr.port;
      resolveOuter({
        redirectUri: `http://localhost:${port}${DEFAULT_CALLBACK_PATH}`,
        waitForCallback: waitForCallback.finally(() => {
          clearTimeout(timeout);
          server.close();
        }),
        shutdown: () => {
          clearTimeout(timeout);
          server.close();
        },
      });
    });
  });
}

/**
 * Run the OIDC browser-redirect login flow. Mirrors `vault login -method=oidc`.
 * On success, the resulting token is cached via safeStorage and the new status
 * is returned.
 */
export async function loginOidc(): Promise<VaultStatus> {
  const config = getVaultConfig();
  if (!config.enabled) throw new VaultError('Vault integration is disabled');
  if (!config.addr) throw new VaultError('Vault address is not configured');
  if (!config.role) throw new VaultError('Vault OIDC role is not configured');

  const client = new VaultClient({ addr: config.addr, namespace: config.namespace || undefined });
  const { redirectUri, waitForCallback, shutdown } = await startCallbackServer();

  try {
    const { auth_url } = await client.oidcAuthUrl(config.role, redirectUri);
    await shell.openExternal(auth_url);
    const { state, code, idToken } = await waitForCallback;
    const callback = await client.oidcCallback(state, code, idToken);
    let expiresAt: string | undefined;
    if (callback.ttl_seconds > 0) {
      expiresAt = new Date(Date.now() + callback.ttl_seconds * 1000).toISOString();
    }
    // Lookup-self to get the friendly identity name
    let identity = callback.identity;
    try {
      client.setToken(callback.client_token);
      const self = await client.lookupSelf();
      if (self.identity) identity = self.identity;
      if (self.expiresAt) expiresAt = self.expiresAt;
    } catch {
      // Non-fatal — we still got a token, just won't have the friendly name
    }
    setCachedToken(callback.client_token, expiresAt, identity);
    return getStatus();
  } catch (err) {
    shutdown();
    throw err;
  }
}

export function logoutVault(): void {
  clearCachedToken();
}
