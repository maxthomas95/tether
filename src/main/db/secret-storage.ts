import { safeStorage } from 'electron';
import { isVaultRef } from '../vault/vault-resolver';

const ENCRYPTED_PREFIX = 'tether-safe:v1:';
const SENSITIVE_ENV_KEY_RE = /(^|_)(api_?key|token|secret|password|passwd|credential|private_?key|pat)(_|$)/i;

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(ENCRYPTED_PREFIX);
}

export function looksSensitiveEnvKey(key: string): boolean {
  return SENSITIVE_ENV_KEY_RE.test(key);
}

export function encryptSecretForStorage(value: string, label: string): string {
  if (!value || isVaultRef(value) || isEncryptedSecret(value)) return value;
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(`OS keychain is not available; cannot persist ${label}`);
  }
  return ENCRYPTED_PREFIX + safeStorage.encryptString(value).toString('base64');
}

export function decryptSecretFromStorage(value: string, label: string): string {
  if (!isEncryptedSecret(value)) return value;
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(`OS keychain is not available; cannot read ${label}`);
  }
  return safeStorage.decryptString(Buffer.from(value.slice(ENCRYPTED_PREFIX.length), 'base64'));
}

export function encryptEnvVarsRecord(vars: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) {
    out[key] = looksSensitiveEnvKey(key)
      ? encryptSecretForStorage(value, `environment variable ${key}`)
      : value;
  }
  return out;
}

export function decryptEnvVarsRecord(vars: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) {
    out[key] = typeof value === 'string'
      ? decryptSecretFromStorage(value, `environment variable ${key}`)
      : value;
  }
  return out;
}

export function encryptEnvVarsJson(rawJson: string): string {
  const parsed = JSON.parse(rawJson || '{}') as Record<string, string>;
  return JSON.stringify(encryptEnvVarsRecord(parsed));
}

export function decryptEnvVarsJson(rawJson: string): string {
  const parsed = JSON.parse(rawJson || '{}') as Record<string, string>;
  return JSON.stringify(decryptEnvVarsRecord(parsed));
}

