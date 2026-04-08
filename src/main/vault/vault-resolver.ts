import { buildClient } from './vault-auth';
import { ParsedVaultRef, VaultError } from './vault-types';

export const VAULT_REF_PREFIX = 'vault://';

export function isVaultRef(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(VAULT_REF_PREFIX);
}

/**
 * Parse a `vault://<mount>/<path>#<key>` reference.
 *
 * Examples:
 *  - `vault://secret/tether/ssh/prod#password`
 *      → { mount: "secret", path: "tether/ssh/prod", key: "password" }
 *  - `vault://secret/tether/api-keys#ANTHROPIC_API_KEY`
 *      → { mount: "secret", path: "tether/api-keys", key: "ANTHROPIC_API_KEY" }
 *
 * Returns null for malformed inputs (callers should treat as a hard error).
 */
export function parseRef(ref: string): ParsedVaultRef | null {
  if (!isVaultRef(ref)) return null;
  const withoutPrefix = ref.slice(VAULT_REF_PREFIX.length);
  const hashIdx = withoutPrefix.indexOf('#');
  if (hashIdx <= 0) return null;
  const pathPart = withoutPrefix.slice(0, hashIdx);
  const key = withoutPrefix.slice(hashIdx + 1);
  if (!key) return null;
  const slashIdx = pathPart.indexOf('/');
  if (slashIdx <= 0 || slashIdx === pathPart.length - 1) return null;
  const mount = pathPart.slice(0, slashIdx);
  const path = pathPart.slice(slashIdx + 1);
  return { mount, path, key };
}

export function buildRef(mount: string, path: string, key: string): string {
  return `${VAULT_REF_PREFIX}${mount}/${path}#${key}`;
}

/**
 * Resolve a single vault:// reference to its plaintext value.
 * Throws VaultError on any failure (Vault unreachable, not logged in,
 * secret/key not found).
 */
export async function resolveRef(ref: string): Promise<string> {
  const parsed = parseRef(ref);
  if (!parsed) throw new VaultError(`Malformed Vault reference: ${ref}`);
  const client = buildClient();
  if (!client) throw new VaultError('Vault integration is not enabled');
  if (!client.hasToken()) throw new VaultError('Not logged in to Vault — open Settings to log in');
  const result = await client.kvRead(parsed.mount, parsed.path);
  const value = result.data?.[parsed.key];
  if (value === undefined || value === null) {
    throw new VaultError(`Vault secret ${parsed.mount}/${parsed.path} has no field "${parsed.key}"`);
  }
  if (typeof value !== 'string') {
    throw new VaultError(
      `Vault secret ${parsed.mount}/${parsed.path}#${parsed.key} is not a string (got ${typeof value})`,
    );
  }
  return value;
}

/**
 * Resolve any vault:// references in a flat string-keyed dict (typical
 * env-var shape). Non-ref values pass through unchanged. If any reference
 * fails to resolve, the whole call rejects — partial resolution would leave
 * the caller with a half-broken environment.
 */
export async function resolveAll(input: Record<string, string>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const refs: Array<{ key: string; ref: string }> = [];
  for (const [k, v] of Object.entries(input)) {
    if (isVaultRef(v)) refs.push({ key: k, ref: v });
    else out[k] = v;
  }
  if (refs.length === 0) return out;
  // Resolve in parallel — Vault calls are network round-trips
  const resolved = await Promise.all(refs.map(r => resolveRef(r.ref)));
  refs.forEach((r, i) => {
    out[r.key] = resolved[i];
  });
  return out;
}
