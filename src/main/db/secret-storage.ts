import { safeStorage } from 'electron';

const ENCRYPTED_PREFIX = 'tether-safe:v1:';
const SENSITIVE_ENV_KEY_RE = /(^|_)(api_?key|token|secret|password|passwd|credential|private_?key|pat)(_|$)/i;

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(ENCRYPTED_PREFIX);
}

export function looksSensitiveEnvKey(key: string): boolean {
  return SENSITIVE_ENV_KEY_RE.test(key);
}

export function encryptSecretForStorage(value: string, label: string): string {
  if (!value || value.startsWith('vault://') || isEncryptedSecret(value)) return value;
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
    if (typeof value !== 'string') throw new Error(`Invalid environment variable ${key}`);
    out[key] = encryptSecretForStorage(value, `environment variable ${key}`);
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
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid environment variables');
  return JSON.stringify(encryptEnvVarsRecord(parsed));
}

export const SECRET_CONFIG_KEYS: ReadonlySet<string> = new Set(['jobsToken', 'notifications.webhook.token']);

export function isSecretConfigValue(key: string, value: string): boolean {
  return value !== 'true' && value !== 'false' &&
    (SECRET_CONFIG_KEYS.has(key) || /token|secret|password|credential|apikey|api_key/i.test(key));
}

export function decryptEnvVarsJson(rawJson: string): string {
  const parsed = JSON.parse(rawJson || '{}') as Record<string, string>;
  return JSON.stringify(decryptEnvVarsRecord(parsed));
}

