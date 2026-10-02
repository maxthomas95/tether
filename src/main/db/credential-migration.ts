import { safeStorage } from 'electron';
import type { DbData } from './database';
import { encryptEnvVarsJson, encryptEnvVarsRecord, encryptSecretForStorage, isSecretConfigValue } from './secret-storage';

/** Idempotent. The caller must persist successfully before exposing the result. */
export function migrateStoredCredentials(input: DbData): DbData {
  const db: DbData = JSON.parse(JSON.stringify(input));
  db.defaultEnvVars = encryptEnvVarsRecord(db.defaultEnvVars);
  for (const env of db.environments) {
    env.env_vars = encryptEnvVarsJson(env.env_vars);
    const config = JSON.parse(env.config || '{}');
    if (typeof config.password === 'string' && config.password && !config.passwordEncrypted && !config.password.startsWith('vault://')) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('OS keychain is not available; cannot migrate SSH password');
      config.password = safeStorage.encryptString(config.password).toString('base64');
      config.passwordEncrypted = true;
      env.config = JSON.stringify(config);
    }
  }
  for (const profile of db.launchProfiles) profile.env_vars = encryptEnvVarsJson(profile.env_vars);
  for (const provider of db.gitProviders) provider.token = encryptSecretForStorage(provider.token, 'Git provider token');
  for (const [key, value] of Object.entries(db.config)) {
    // Vault's token already uses its own safeStorage base64 format.
    if (key !== 'vaultToken' && key !== 'vaultTokenExpiresAt' && isSecretConfigValue(key, value)) {
      db.config[key] = encryptSecretForStorage(value, `setting ${key}`);
    }
  }
  return db;
}
