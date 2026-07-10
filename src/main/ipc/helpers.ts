import { safeStorage, type BrowserWindow } from 'electron';
import { isVaultRef, resolveRef } from '../vault/vault-resolver';
import { decryptSecretFromStorage } from '../db/secret-storage';

/** Shared dependencies passed into each domain's `register*Handlers` function. */
export interface HandlerContext {
  mainWindow: BrowserWindow;
  send: (channel: string, ...args: unknown[]) => void;
}

export function encryptConfigPassword(config: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!config || typeof config.password !== 'string') return config;
  const copy = { ...config };
  // Vault references are not secrets — store them verbatim
  if (isVaultRef(copy.password as string)) {
    delete copy.passwordEncrypted;
    return copy;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS keychain is not available; cannot persist SSH password');
  }
  copy.password = safeStorage.encryptString(copy.password as string).toString('base64');
  copy.passwordEncrypted = true;
  return copy;
}

export function decryptConfigPassword(config: Record<string, unknown>): Record<string, unknown> {
  if (typeof config.password !== 'string') return config;
  // Vault refs pass through to the renderer unchanged — they're not secrets
  if (isVaultRef(config.password)) return config;
  if (!config.passwordEncrypted) return config;
  const copy = { ...config };
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS keychain is not available; cannot read SSH password');
  }
  copy.password = safeStorage.decryptString(Buffer.from(copy.password as string, 'base64'));
  delete copy.passwordEncrypted;
  return copy;
}

export async function resolveProviderToken(token: string): Promise<string> {
  if (isVaultRef(token)) return resolveRef(token);
  return decryptSecretFromStorage(token, 'Git provider token');
}
