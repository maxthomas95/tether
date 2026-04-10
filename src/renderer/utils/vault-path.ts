import type { VaultStatus, VaultConfig } from '../../shared/types';

export const VAULT_REF_PREFIX = 'vault://';

/** Strip common auth-method prefixes from a Vault display identity. */
export function cleanIdentity(identity: string | undefined): string {
  if (!identity) return '';
  return identity.replace(/^[a-z]+-/, '');
}

/** Convert a human label into a filesystem/vault-safe slug. */
export function slugify(s: string, fallback = 'item'): string {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || fallback;
}

/**
 * Build a suggested vault:// reference for a secret owned by the current user.
 * Example: vault://users/mathomas@uwcu.org/tether/ssh/my-vm#password
 */
export function suggestVaultPath(
  config: { mount: string },
  status: { identity?: string },
  category: string,
  name: string,
  key: string,
): string {
  const mount = config.mount || 'secret';
  const identity = cleanIdentity(status.identity);
  const identitySegment = identity ? `${identity}/` : '';
  return `${VAULT_REF_PREFIX}${mount}/${identitySegment}tether/${category}/${slugify(name)}#${key}`;
}

/** Type-narrowed helpers so the callers can pass their whole state objects. */
export type VaultPathContext = { config: Pick<VaultConfig, 'mount'>; status: Pick<VaultStatus, 'identity'> };
