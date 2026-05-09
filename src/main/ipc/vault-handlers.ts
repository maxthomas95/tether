import { ipcMain, safeStorage } from 'electron';
import { IPC } from '../../shared/constants';
import type {
  VaultConfig,
  VaultStatus,
  VaultPlaintextSecret,
  MigrateSecretOptions,
} from '../../shared/types';
import {
  getVaultConfig,
  setVaultConfig,
  loginOidc,
  cancelLoginOidc,
  logoutVault,
  getStatus as getVaultStatus,
  buildClient as buildVaultClient,
  DEFAULT_VAULT_CONFIG,
  setExpiryWarningCallback,
} from '../vault/vault-auth';
import { isVaultRef, resolveRef, parseRef, buildRef } from '../vault/vault-resolver';
import { createLogger } from '../logger';
import type { HandlerContext } from './helpers';

const log = createLogger('ipc:vault');

export function registerVaultHandlers(ctx: HandlerContext): void {
  const { send } = ctx;

  function emitVaultStatus(status: VaultStatus): void {
    send(IPC.VAULT_STATUS_CHANGED, status);
  }

  setExpiryWarningCallback((expiresAt) => {
    send(IPC.VAULT_EXPIRY_WARNING, { expiresAt });
  });

  ipcMain.handle(IPC.VAULT_GET_CONFIG, async (): Promise<VaultConfig> => {
    const cfg = getVaultConfig();
    // If nothing has been saved yet, return the defaults so the UI gets a sane starting point
    if (!cfg.addr && !cfg.role) return DEFAULT_VAULT_CONFIG;
    return cfg;
  });

  ipcMain.handle(IPC.VAULT_SET_CONFIG, async (_event, config: VaultConfig) => {
    setVaultConfig(config);
    emitVaultStatus(getVaultStatus());
  });

  ipcMain.handle(IPC.VAULT_LOGIN, async (): Promise<VaultStatus> => {
    log.info('Vault OIDC login initiated');
    const status = await loginOidc();
    log.info('Vault login result', { loggedIn: status.loggedIn, identity: status.identity });
    emitVaultStatus(status);
    return status;
  });

  ipcMain.handle(IPC.VAULT_CANCEL_LOGIN, async (): Promise<void> => {
    log.info('Vault OIDC login cancel requested');
    cancelLoginOidc();
  });

  ipcMain.handle(IPC.VAULT_LOGOUT, async () => {
    logoutVault();
    emitVaultStatus(getVaultStatus());
  });

  ipcMain.handle(IPC.VAULT_STATUS, async (): Promise<VaultStatus> => {
    return getVaultStatus();
  });

  ipcMain.handle(IPC.VAULT_TEST_REF, async (_event, ref: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      // Resolve, but never return the value to the renderer — only success/failure
      await resolveRef(ref);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(IPC.VAULT_LIST_KEYS, async (_event, mount: string, path: string): Promise<string[]> => {
    const client = buildVaultClient();
    if (!client) throw new Error('Vault integration is not enabled');
    if (!client.hasToken()) throw new Error('Not logged in to Vault');
    return client.kvList(mount, path);
  });

  // Reads a secret and returns only its field names — never the values.
  // Used by the Vault picker so the user can choose which #field to reference
  // without the renderer ever seeing the plaintext.
  ipcMain.handle(IPC.VAULT_LIST_FIELDS, async (_event, mount: string, path: string): Promise<string[]> => {
    const client = buildVaultClient();
    if (!client) throw new Error('Vault integration is not enabled');
    if (!client.hasToken()) throw new Error('Not logged in to Vault');
    const result = await client.kvRead(mount, path);
    return Object.keys(result.data || {});
  });

  ipcMain.handle(IPC.VAULT_WRITE_SECRET, async (_event, ref: string, value: string): Promise<void> => {
    const client = buildVaultClient();
    if (!client) throw new Error('Vault integration is not enabled');
    if (!client.hasToken()) throw new Error('Not logged in to Vault');
    const parsed = parseRef(ref);
    if (!parsed) throw new Error(`Malformed Vault reference: ${ref}`);
    await client.kvWrite(parsed.mount, parsed.path, { [parsed.key]: value });
  });

  ipcMain.handle(IPC.VAULT_LIST_PLAINTEXT, async (): Promise<VaultPlaintextSecret[]> => {
    const { getDb } = await import('../db/database');
    const db = getDb();
    const out: VaultPlaintextSecret[] = [];
    const sensitiveKey = /key|secret|token|password/i;
    // Sonar S5852: prefer a while-loop trim over `/^-+|-+$/g` — the regex variant
    // gets flagged for super-linear backtracking even though this input is bounded.
    const slugify = (s: string): string => {
      let out = s.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
      while (out.startsWith('-')) out = out.slice(1);
      while (out.endsWith('-')) out = out.slice(0, -1);
      return out || 'item';
    };

    // SSH passwords on environments
    for (const env of db.environments) {
      if (env.type !== 'ssh') continue;
      try {
        const cfg = JSON.parse(env.config) as Record<string, unknown>;
        if (typeof cfg.password === 'string' && cfg.password && !isVaultRef(cfg.password)) {
          out.push({
            source: 'sshPassword',
            sourceId: env.id,
            displayName: `SSH password — ${env.name}`,
            suggestedRef: buildRef('secret', `tether/ssh/${slugify(env.name)}`, 'password'),
          });
        }
      } catch { /* ignore malformed config */ }
    }

    // Git provider tokens
    for (const provider of db.gitProviders) {
      if (provider.token && !isVaultRef(provider.token)) {
        out.push({
          source: 'gitProvider',
          sourceId: provider.id,
          displayName: `Git provider token — ${provider.name}`,
          suggestedRef: buildRef('secret', `tether/git/${slugify(provider.name)}`, 'token'),
        });
      }
    }

    // Default env vars (sensitive only)
    for (const [k, v] of Object.entries(db.defaultEnvVars)) {
      if (!sensitiveKey.test(k)) continue;
      if (!v || isVaultRef(v)) continue;
      out.push({
        source: 'envVar',
        key: k,
        displayName: `Default env var — ${k}`,
        suggestedRef: buildRef('secret', 'tether/api-keys', k),
      });
    }

    // Per-environment env vars (sensitive only)
    for (const env of db.environments) {
      let envVars: Record<string, string> = {};
      try { envVars = JSON.parse(env.env_vars || '{}'); } catch { continue; }
      for (const [k, v] of Object.entries(envVars)) {
        if (!sensitiveKey.test(k)) continue;
        if (!v || isVaultRef(v)) continue;
        out.push({
          source: 'envEnvVar',
          sourceId: env.id,
          key: k,
          displayName: `${env.name} env var — ${k}`,
          suggestedRef: buildRef('secret', `tether/env/${slugify(env.name)}`, k),
        });
      }
    }

    return out;
  });

  ipcMain.handle(IPC.VAULT_MIGRATE_SECRET, async (_event, opts: MigrateSecretOptions): Promise<void> => {
    log.info('Migrating secret to Vault', { source: opts.source, targetRef: opts.targetRef });
    const { getDb, saveDb } = await import('../db/database');
    const db = getDb();
    const client = buildVaultClient();
    if (!client) throw new Error('Vault integration is not enabled');
    if (!client.hasToken()) throw new Error('Not logged in to Vault');

    const parsed = parseRef(opts.targetRef);
    if (!parsed) throw new Error(`Malformed target Vault reference: ${opts.targetRef}`);

    // 1) Read current plaintext value from data.json
    let currentValue: string | undefined;
    let writebackRef: () => void;
    switch (opts.source) {
      case 'sshPassword': {
        const env = db.environments.find(e => e.id === opts.sourceId);
        if (!env) throw new Error('Environment not found');
        const cfg = JSON.parse(env.config) as Record<string, unknown>;
        let value = cfg.password as string | undefined;
        if (typeof value === 'string' && cfg.passwordEncrypted && safeStorage.isEncryptionAvailable()) {
          value = safeStorage.decryptString(Buffer.from(value, 'base64'));
        }
        if (!value) throw new Error('SSH environment has no plaintext password to migrate');
        currentValue = value;
        writebackRef = () => {
          cfg.password = opts.targetRef;
          delete cfg.passwordEncrypted;
          env.config = JSON.stringify(cfg);
          env.updated_at = new Date().toISOString();
        };
        break;
      }
      case 'gitProvider': {
        const provider = db.gitProviders.find(p => p.id === opts.sourceId);
        if (!provider) throw new Error('Git provider not found');
        if (!provider.token) throw new Error('Git provider has no token to migrate');
        currentValue = provider.token;
        writebackRef = () => {
          provider.token = opts.targetRef;
          provider.updated_at = new Date().toISOString();
        };
        break;
      }
      case 'envVar': {
        if (!opts.key) throw new Error('Missing env var key');
        const value = db.defaultEnvVars[opts.key];
        if (!value) throw new Error(`Default env var ${opts.key} not found`);
        currentValue = value;
        writebackRef = () => {
          db.defaultEnvVars[opts.key as string] = opts.targetRef;
        };
        break;
      }
      case 'envEnvVar': {
        if (!opts.key) throw new Error('Missing env var key');
        const env = db.environments.find(e => e.id === opts.sourceId);
        if (!env) throw new Error('Environment not found');
        const envVars = JSON.parse(env.env_vars || '{}') as Record<string, string>;
        const value = envVars[opts.key];
        if (!value) throw new Error(`Env var ${opts.key} not found on environment`);
        currentValue = value;
        writebackRef = () => {
          envVars[opts.key as string] = opts.targetRef;
          env.env_vars = JSON.stringify(envVars);
          env.updated_at = new Date().toISOString();
        };
        break;
      }
      default:
        throw new Error(`Unknown migration source: ${opts.source}`);
    }

    // 2) Write the secret to Vault. Merge with any existing fields at that path
    //    so we don't clobber sibling keys.
    let existing: Record<string, unknown> = {};
    try {
      const result = await client.kvRead(parsed.mount, parsed.path);
      existing = result.data;
    } catch (err) {
      // 404 = secret doesn't exist yet, that's fine. Other errors propagate.
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('404')) throw err;
    }
    await client.kvWrite(parsed.mount, parsed.path, { ...existing, [parsed.key]: currentValue });

    // 3) Replace the in-DB value with the reference and persist
    writebackRef();
    saveDb();
  });
}
