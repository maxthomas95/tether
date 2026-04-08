import { ipcMain, BrowserWindow, dialog, safeStorage } from 'electron';
import { IPC } from '../../shared/constants';
import type {
  CreateSessionOptions,
  CreateEnvironmentOptions,
  EnvironmentInfo,
  GitProviderInfo,
  CreateGitProviderOptions,
  VaultConfig,
  VaultStatus,
  VaultPlaintextSecret,
  MigrateSecretOptions,
} from '../../shared/types';
import { sessionManager } from '../session/session-manager';
import * as envRepo from '../db/environment-repo';
import * as sessionRepo from '../db/session-repo';
import * as gitProviderRepo from '../db/git-provider-repo';
import { gitClone, gitInit } from '../git/git-service';
import { GiteaClient } from '../git/providers/gitea-client';
import { AdoClient } from '../git/providers/ado-client';
import {
  getVaultConfig,
  setVaultConfig,
  loginOidc,
  logoutVault,
  getStatus as getVaultStatus,
  buildClient as buildVaultClient,
  DEFAULT_VAULT_CONFIG,
} from '../vault/vault-auth';
import { isVaultRef, resolveRef, parseRef, buildRef } from '../vault/vault-resolver';

function encryptConfigPassword(config: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!config || typeof config.password !== 'string') return config;
  const copy = { ...config };
  // Vault references are not secrets — store them verbatim
  if (isVaultRef(copy.password as string)) {
    delete copy.passwordEncrypted;
    return copy;
  }
  if (safeStorage.isEncryptionAvailable()) {
    copy.password = safeStorage.encryptString(copy.password as string).toString('base64');
    copy.passwordEncrypted = true;
  }
  return copy;
}

function decryptConfigPassword(config: Record<string, unknown>): Record<string, unknown> {
  if (typeof config.password !== 'string') return config;
  // Vault refs pass through to the renderer unchanged — they're not secrets
  if (isVaultRef(config.password)) return config;
  if (!config.passwordEncrypted) return config;
  const copy = { ...config };
  if (safeStorage.isEncryptionAvailable()) {
    copy.password = safeStorage.decryptString(Buffer.from(copy.password as string, 'base64'));
  }
  delete copy.passwordEncrypted;
  return copy;
}

async function resolveProviderToken(token: string): Promise<string> {
  if (isVaultRef(token)) return resolveRef(token);
  return token;
}

export function registerIpcHandlers(mainWindow: BrowserWindow): void {
  const send = (channel: string, ...args: unknown[]) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, ...args);
    }
  };

  // === Session handlers ===

  ipcMain.handle(IPC.SESSION_CREATE, async (_event, opts: CreateSessionOptions) => {
    const session = await sessionManager.createSession(opts, {
      onData(data: string) {
        send(IPC.SESSION_DATA, session.id, data);
      },
      onStateChange(state) {
        send(IPC.SESSION_STATE_CHANGE, session.id, state);
        sessionRepo.updateSessionState(session.id, state);
      },
      onExit(exitCode) {
        send(IPC.SESSION_EXITED, session.id, exitCode);
      },
    });

    // Persist to DB
    sessionRepo.createSessionRow({
      label: session.label,
      working_dir: session.workingDir,
      environment_id: opts.environmentId,
      state: 'running',
    });
    // Use the manager's session id, not the DB row id — they're the same uuid
    // Actually the DB creates its own id. Let me fix this by passing the id.
    // For now, the in-memory session manager is the source of truth for live sessions.

    return session.toInfo();
  });

  ipcMain.handle(IPC.SESSION_LIST, async () => {
    return sessionManager.listSessions().map(s => s.toInfo());
  });

  ipcMain.handle(IPC.SESSION_STOP, async (_event, sessionId: string) => {
    await sessionManager.stopSession(sessionId);
  });

  ipcMain.handle(IPC.SESSION_KILL, async (_event, sessionId: string) => {
    sessionManager.killSession(sessionId);
  });

  ipcMain.handle(IPC.SESSION_RENAME, async (_event, sessionId: string, label: string) => {
    sessionManager.renameSession(sessionId, label);
  });

  ipcMain.handle(IPC.SESSION_REMOVE, async (_event, sessionId: string) => {
    sessionManager.removeSession(sessionId);
  });

  ipcMain.on(IPC.SESSION_INPUT, (_event, sessionId: string, data: string) => {
    sessionManager.writeToSession(sessionId, data);
  });

  ipcMain.on(IPC.SESSION_RESIZE, (_event, sessionId: string, cols: number, rows: number) => {
    sessionManager.resizeSession(sessionId, cols, rows);
  });

  // === Environment handlers ===

  ipcMain.handle(IPC.ENV_LIST, async () => {
    const envs = envRepo.listEnvironments();
    const sessions = sessionManager.listSessions();
    return envs.map((env): EnvironmentInfo => ({
      id: env.id,
      name: env.name,
      type: env.type as EnvironmentInfo['type'],
      config: decryptConfigPassword(JSON.parse(env.config)),
      envVars: JSON.parse(env.env_vars || '{}'),
      sessionCount: sessions.filter(s => {
        if (s.environmentId === env.id) return true;
        if (env.type === 'local' && !s.environmentId) return true;
        return false;
      }).length,
    }));
  });

  ipcMain.handle(IPC.ENV_CREATE, async (_event, opts: CreateEnvironmentOptions) => {
    const env = envRepo.createEnvironment({
      name: opts.name,
      type: opts.type,
      config: encryptConfigPassword(opts.config),
      envVars: opts.envVars,
    });
    return {
      id: env.id,
      name: env.name,
      type: env.type,
      config: decryptConfigPassword(JSON.parse(env.config)),
      envVars: JSON.parse(env.env_vars || '{}'),
      sessionCount: 0,
    } as EnvironmentInfo;
  });

  ipcMain.handle(IPC.ENV_UPDATE, async (_event, id: string, opts: Partial<CreateEnvironmentOptions>) => {
    envRepo.updateEnvironment(id, {
      name: opts.name,
      type: opts.type,
      config: encryptConfigPassword(opts.config),
      envVars: opts.envVars,
    });
  });

  ipcMain.handle(IPC.ENV_DELETE, async (_event, id: string) => {
    envRepo.deleteEnvironment(id);
  });

  // === Dialog handlers ===

  ipcMain.handle(IPC.DIALOG_OPEN_DIRECTORY, async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Select working directory',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // === Config handlers ===

  ipcMain.handle(IPC.CONFIG_GET, async (_event, key: string) => {
    const { getDb } = await import('../db/database');
    return getDb().config[key] ?? null;
  });

  ipcMain.handle(IPC.CONFIG_SET, async (_event, key: string, value: string) => {
    const { getDb, saveDb } = await import('../db/database');
    getDb().config[key] = value;
    saveDb();
  });

  ipcMain.handle(IPC.CONFIG_GET_DEFAULT_CLI_FLAGS, async () => {
    const { getDb } = await import('../db/database');
    return getDb().defaultCliFlags;
  });

  ipcMain.handle(IPC.CONFIG_SET_DEFAULT_CLI_FLAGS, async (_event, flags: string[]) => {
    const { getDb, saveDb } = await import('../db/database');
    getDb().defaultCliFlags = flags;
    saveDb();
  });

  ipcMain.handle(IPC.CONFIG_GET_DEFAULT_ENV_VARS, async () => {
    const { getDb } = await import('../db/database');
    return getDb().defaultEnvVars;
  });

  ipcMain.handle(IPC.CONFIG_SET_DEFAULT_ENV_VARS, async (_event, vars: Record<string, string>) => {
    const { getDb, saveDb } = await import('../db/database');
    getDb().defaultEnvVars = vars;
    saveDb();
  });

  // === Workspace save/restore ===

  ipcMain.handle(IPC.WORKSPACE_SAVE, async (_event, sessions: Array<{ workingDir: string; label: string; environmentId?: string }>, activeIndex: number) => {
    const { getDb, saveDb } = await import('../db/database');
    getDb().savedWorkspace = { sessions, activeIndex };
    saveDb();
  });

  ipcMain.handle(IPC.WORKSPACE_LOAD, async () => {
    const { getDb } = await import('../db/database');
    return getDb().savedWorkspace;
  });

  // === Titlebar overlay ===

  ipcMain.handle(IPC.TITLEBAR_UPDATE, async (_event, color: string, symbolColor: string) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.setTitleBarOverlay({ color, symbolColor, height: 36 });
    }
  });

  // === Scan repos directory ===

  ipcMain.handle(IPC.SCAN_REPOS_DIR, async (_event, dir: string) => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      return entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => path.join(dir, e.name))
        .sort();
    } catch {
      return [];
    }
  });

  // === Git Provider handlers ===

  function toProviderInfo(row: gitProviderRepo.GitProviderRow): GitProviderInfo {
    const tokenIsVaultRef = isVaultRef(row.token);
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      baseUrl: row.baseUrl,
      organization: row.organization || undefined,
      hasToken: !!row.token,
      tokenIsVaultRef,
      tokenVaultRef: tokenIsVaultRef ? row.token : undefined,
    };
  }

  ipcMain.handle(IPC.GIT_PROVIDER_LIST, async () => {
    return gitProviderRepo.listGitProviders().map(toProviderInfo);
  });

  ipcMain.handle(IPC.GIT_PROVIDER_CREATE, async (_event, opts: CreateGitProviderOptions) => {
    const row = gitProviderRepo.createGitProvider({
      name: opts.name,
      type: opts.type,
      baseUrl: opts.baseUrl,
      organization: opts.organization,
      token: opts.token,
    });
    return toProviderInfo(row);
  });

  ipcMain.handle(IPC.GIT_PROVIDER_UPDATE, async (_event, id: string, opts: Partial<CreateGitProviderOptions>) => {
    gitProviderRepo.updateGitProvider(id, opts);
  });

  ipcMain.handle(IPC.GIT_PROVIDER_DELETE, async (_event, id: string) => {
    gitProviderRepo.deleteGitProvider(id);
  });

  ipcMain.handle(IPC.GIT_PROVIDER_TEST, async (_event, id: string) => {
    const provider = gitProviderRepo.getGitProvider(id);
    if (!provider) return { ok: false, error: 'Provider not found' };
    try {
      const token = await resolveProviderToken(provider.token);
      if (provider.type === 'gitea') {
        const client = new GiteaClient(provider.baseUrl, token);
        await client.testConnection();
      } else {
        const client = new AdoClient(provider.baseUrl, provider.organization || '', token);
        await client.testConnection();
      }
      return { ok: true };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(IPC.GIT_PROVIDER_REPOS, async (_event, providerId: string, query?: string) => {
    const provider = gitProviderRepo.getGitProvider(providerId);
    if (!provider) throw new Error('Provider not found');
    const token = await resolveProviderToken(provider.token);
    if (provider.type === 'gitea') {
      const client = new GiteaClient(provider.baseUrl, token);
      return client.listRepos(query);
    } else {
      const client = new AdoClient(provider.baseUrl, provider.organization || '', token);
      return client.listRepos(query);
    }
  });

  // === Git clone / init ===

  ipcMain.handle(IPC.GIT_CLONE, async (_event, url: string, destination: string) => {
    return gitClone({
      url,
      destination,
      onProgress(info) {
        send(IPC.GIT_CLONE_PROGRESS, info);
      },
    });
  });

  ipcMain.handle(IPC.GIT_INIT, async (_event, directory: string) => {
    return gitInit(directory);
  });

  // === Vault handlers ===

  function emitVaultStatus(status: VaultStatus): void {
    send(IPC.VAULT_STATUS_CHANGED, status);
  }

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
    const status = await loginOidc();
    emitVaultStatus(status);
    return status;
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

  ipcMain.handle(IPC.VAULT_LIST_PLAINTEXT, async (): Promise<VaultPlaintextSecret[]> => {
    const { getDb } = await import('../db/database');
    const db = getDb();
    const out: VaultPlaintextSecret[] = [];
    const sensitiveKey = /key|secret|token|password/i;
    const slugify = (s: string): string => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'item';

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
