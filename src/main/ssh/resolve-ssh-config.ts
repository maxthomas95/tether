import { isVaultRef, resolveRef } from '../vault/vault-resolver';
import { decryptConfigPassword } from '../ipc/helpers';
import type { SSHConfig } from '../transport/ssh-transport';

/**
 * Resolve a stored SSH environment `config` blob into a ready-to-connect
 * `SSHConfig`: vault:// password references are resolved against Vault, and
 * safeStorage-encrypted passwords are decrypted. Shared by the PTY transport
 * factory (session-manager) and the remote hook agent's control connection so
 * both always authenticate identically.
 */
export async function resolveSshConfig(raw: Record<string, unknown>): Promise<SSHConfig> {
  // Resolve password: vault ref → resolved string, encrypted-at-rest → decrypted string
  const decrypted = decryptConfigPassword(raw);
  let password = decrypted.password as string | undefined;
  if (typeof password === 'string' && isVaultRef(password)) {
    // Vault refs are stored as-is (encryptConfigPassword leaves them alone)
    password = await resolveRef(password);
  }
  const config = decrypted as Partial<SSHConfig>;
  return {
    host: config.host || 'localhost',
    port: config.port || 22,
    username: config.username || 'root',
    privateKeyPath: config.privateKeyPath,
    useAgent: config.useAgent ?? (!config.privateKeyPath && !password),
    password,
    useSudo: !!decrypted.useSudo,
  };
}
