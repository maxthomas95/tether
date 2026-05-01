import { ipcMain, BrowserWindow, dialog, safeStorage, shell } from 'electron';
import { IPC } from '../../shared/constants';
import type {
  CreateSessionOptions,
  CreateEnvironmentOptions,
  CreateLaunchProfileOptions,
  EnvironmentInfo,
  LaunchProfileInfo,
  GitProviderInfo,
  CreateGitProviderOptions,
  VaultConfig,
  VaultStatus,
  VaultPreflightResult,
  VaultPlaintextSecret,
  MigrateSecretOptions,
  CoderWorkspace,
  CoderTemplate,
  CoderTemplateParam,
  CreateCoderWorkspaceOptions,
  QuotaInfo,
  UsageInfo,
  SessionUsage,
  CliToolId,
} from '../../shared/types';
import { sessionManager, findVaultRefInSession, setHelmChildCallbacks } from '../session/session-manager';
import { quotaService } from '../quota/quota-service';
import { usageService } from '../usage/usage-service';
import * as envRepo from '../db/environment-repo';
import * as sessionRepo from '../db/session-repo';
import * as profileRepo from '../db/profile-repo';
import * as gitProviderRepo from '../db/git-provider-repo';
import { gitClone, gitInit, gitWorktreeAdd, gitWorktreeRemove, isGitRepo } from '../git/git-service';
import { createCoderWorkspace, listCoderWorkspaces, listCoderTemplates, getCoderTemplateParams } from '../coder/workspace-service';
import { GiteaClient } from '../git/providers/gitea-client';
import { AdoClient } from '../git/providers/ado-client';
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
import { setHostVerifyDispatcher, respondToHostVerify } from '../ssh/host-verifier';
import * as knownHostsRepo from '../db/known-hosts-repo';
import type { KnownHostInfo, HostVerifyRequest } from '../../shared/types';
import { createLogger } from '../logger';

const log = createLogger('ipc');

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

  // Wire the SSH host-verify prompt dispatcher to the renderer. The verifier
  // module holds the pending callbacks; we just need it to know how to push
  // the prompt out.
  setHostVerifyDispatcher((req: HostVerifyRequest) => {
    send(IPC.SSH_HOST_VERIFY_REQUEST, req);
  });

  ipcMain.on(IPC.SSH_HOST_VERIFY_RESPONSE, (_event, token: string, trust: boolean) => {
    respondToHostVerify(token, trust);
  });

  // === Session handlers ===

  // Single callback bundle, shared between direct IPC session creation and
  // Helm-dispatched children. See `setHelmChildCallbacks` for the rationale.
  const sessionCallbacks = {
    onData(sessionId: string, data: string) {
      send(IPC.SESSION_DATA, sessionId, data);
    },
    onStateChange(sessionId: string, state: import('../../shared/types').SessionState) {
      send(IPC.SESSION_STATE_CHANGE, sessionId, state);
      sessionRepo.updateSessionState(sessionId, state);
    },
    onUpdate(sessionId: string, info: import('../../shared/types').SessionInfo) {
      send(IPC.SESSION_UPDATED, sessionId, info);
    },
    onCreated(sessionId: string, info: import('../../shared/types').SessionInfo) {
      send(IPC.SESSION_CREATED, sessionId, info);
    },
    onExit(sessionId: string, exitCode: number) {
      send(IPC.SESSION_EXITED, sessionId, exitCode);
      const s = sessionManager.getSession(sessionId);
      if (s?.claudeSessionId) {
        usageService.untrackSession(s.claudeSessionId);
      }
    },
  };
  setHelmChildCallbacks(sessionCallbacks);

  ipcMain.handle(IPC.SESSION_CREATE, async (_event, opts: CreateSessionOptions) => {
    log.info('IPC session:create', { workingDir: opts.workingDir, environmentId: opts.environmentId });
    // Callbacks receive sessionId as their first arg — do NOT close over the
    // `session` const below. SSH transports can emit data events between
    // `transport.start()` resolving and the `await` unblocking, which would
    // hit the temporal dead zone on the const binding (v0.1.3 SSH crash).
    const session = await sessionManager.createSession(opts, sessionCallbacks);

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

    // Start tracking usage for Claude sessions
    if (session.claudeSessionId) {
      usageService.trackSession(session.claudeSessionId, session.workingDir);
    }

    return session.toInfo();
  });

  ipcMain.handle(IPC.SESSION_VAULT_PREFLIGHT, async (_event, opts: CreateSessionOptions): Promise<VaultPreflightResult> => {
    const status = getVaultStatus();
    // If Vault isn't enabled or we're already logged in, skip the scan — nothing to prompt about.
    if (!status.enabled || status.loggedIn) return { needsLogin: false };
    const refSource = await findVaultRefInSession(opts);
    if (!refSource) return { needsLogin: false };
    return { needsLogin: true, reason: refSource };
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
    sessionRepo.updateSessionLabel(sessionId, label);
  });

  ipcMain.handle(IPC.SESSION_SET_HELM_ENABLED, async (_event, sessionId: string, enabled: boolean) => {
    sessionManager.setHelmEnabled(sessionId, enabled);
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
    log.info('Creating environment', { name: opts.name, type: opts.type });
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
    log.info('Deleting environment', { id });
    envRepo.deleteEnvironment(id);
  });

  // === Coder handlers ===

  ipcMain.handle(IPC.CODER_LIST_WORKSPACES, async (_event, environmentId: string): Promise<CoderWorkspace[]> => {
    return listCoderWorkspaces(environmentId);
  });

  ipcMain.handle(IPC.CODER_LIST_TEMPLATES, async (_event, environmentId: string): Promise<CoderTemplate[]> => {
    return listCoderTemplates(environmentId);
  });

  ipcMain.handle(IPC.CODER_GET_TEMPLATE_PARAMS, async (_event, environmentId: string, templateVersionId: string): Promise<CoderTemplateParam[]> => {
    return getCoderTemplateParams(environmentId, templateVersionId);
  });

  ipcMain.handle(IPC.CODER_CREATE_WORKSPACE, async (_event, opts: CreateCoderWorkspaceOptions): Promise<CoderWorkspace> => {
    return createCoderWorkspace(opts, (line) => send(IPC.CODER_CREATE_PROGRESS, line));
  });

  // === Profile handlers ===

  ipcMain.handle(IPC.PROFILE_LIST, async () => {
    return profileRepo.listProfiles().map((p): LaunchProfileInfo => ({
      id: p.id,
      name: p.name,
      envVars: JSON.parse(p.env_vars || '{}'),
      cliFlagsPerTool: JSON.parse(p.cli_flags_per_tool || '{}'),
      cliFlags: JSON.parse(p.cli_flags || '[]'),
      isDefault: p.is_default,
    }));
  });

  ipcMain.handle(IPC.PROFILE_CREATE, async (_event, opts: CreateLaunchProfileOptions) => {
    const p = profileRepo.createProfile({
      name: opts.name,
      envVars: opts.envVars,
      cliFlagsPerTool: opts.cliFlagsPerTool,
      cliFlags: opts.cliFlags,
      isDefault: opts.isDefault,
    });
    return {
      id: p.id,
      name: p.name,
      envVars: JSON.parse(p.env_vars || '{}'),
      cliFlagsPerTool: JSON.parse(p.cli_flags_per_tool || '{}'),
      cliFlags: JSON.parse(p.cli_flags || '[]'),
      isDefault: p.is_default,
    } as LaunchProfileInfo;
  });

  ipcMain.handle(IPC.PROFILE_UPDATE, async (_event, id: string, opts: Partial<CreateLaunchProfileOptions>) => {
    profileRepo.updateProfile(id, {
      name: opts.name,
      envVars: opts.envVars,
      cliFlagsPerTool: opts.cliFlagsPerTool,
      cliFlags: opts.cliFlags,
      isDefault: opts.isDefault,
    });
  });

  ipcMain.handle(IPC.PROFILE_DELETE, async (_event, id: string) => {
    profileRepo.deleteProfile(id);
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
    // Forward theme changes to the docs window so it stays in sync.
    if (key === 'theme') {
      const { getDocsWindow } = await import('../index');
      const dw = getDocsWindow();
      if (dw && !dw.isDestroyed()) {
        dw.webContents.send(IPC.DOCS_THEME_CHANGED, value);
      }
    }
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

  ipcMain.handle(IPC.CONFIG_GET_DEFAULT_CLI_FLAGS_PER_TOOL, async () => {
    const { getDb } = await import('../db/database');
    return getDb().defaultCliFlagsPerTool;
  });

  ipcMain.handle(IPC.CONFIG_SET_DEFAULT_CLI_FLAGS_FOR_TOOL, async (_event, toolId: string, flags: string[]) => {
    const { getDb, saveDb } = await import('../db/database');
    const db = getDb();
    if (!db.defaultCliFlagsPerTool) db.defaultCliFlagsPerTool = {};
    if (flags.length > 0) {
      (db.defaultCliFlagsPerTool as Record<string, string[]>)[toolId] = flags;
    } else {
      delete (db.defaultCliFlagsPerTool as Record<string, string[]>)[toolId];
    }
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

  // === Repo group preferences ===

  ipcMain.handle(IPC.REPOGROUP_GET_PREFS, async () => {
    const { getDb } = await import('../db/database');
    return getDb().repoGroupPrefs;
  });

  ipcMain.handle(IPC.REPOGROUP_SET_PREFS, async (_event, environmentId: string, prefs: Array<{ environmentId: string; workingDir: string; pinned: boolean; sortOrder: number }>) => {
    const { getDb, saveDb } = await import('../db/database');
    const db = getDb();
    db.repoGroupPrefs = [
      ...db.repoGroupPrefs.filter(p => p.environmentId !== environmentId),
      ...prefs,
    ];
    saveDb();
  });

  // === Workspace save/restore ===

  ipcMain.handle(IPC.WORKSPACE_SAVE, async (_event, sessions: Array<{ workingDir: string; label: string; environmentId?: string; cliTool?: string; customCliBinary?: string; toolSessionId?: string; claudeSessionId?: string }>, activeIndex: number) => {
    const { getDb, saveDb } = await import('../db/database');
    // Codex toolSessionIds are captured at spawn time via the codex session
    // watcher and pushed to the renderer, so whatever the renderer hands us
    // here is already the real conversation id (or undefined if codex hadn't
    // written its transcript yet — in which case we'd rather not resume than
    // resume a stale/unrelated conversation).
    getDb().savedWorkspace = { sessions, activeIndex };
    saveDb();
  });

  ipcMain.handle(IPC.WORKSPACE_LOAD, async () => {
    const { getDb } = await import('../db/database');
    return getDb().savedWorkspace;
  });

  ipcMain.handle(IPC.TRANSCRIPTS_LIST, async (_event, workingDir: string, cliTool: CliToolId = 'claude') => {
    if (cliTool === 'codex') {
      const { listCodexTranscripts } = await import('../codex/transcripts');
      return listCodexTranscripts(workingDir);
    }
    if (cliTool === 'copilot') {
      const { listCopilotTranscripts } = await import('../copilot/transcripts');
      return listCopilotTranscripts(workingDir);
    }
    if (cliTool === 'opencode') {
      const { listOpencodeTranscripts } = await import('../opencode/transcripts');
      return listOpencodeTranscripts(workingDir);
    }
    const { listTranscripts } = await import('../claude/transcripts');
    return listTranscripts(workingDir);
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
    log.info('Testing git provider', { id, type: provider.type, baseUrl: provider.baseUrl });
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
      log.error('Git provider test failed', { id, error: err instanceof Error ? err.message : String(err) });
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
    log.info('Git clone', { url, destination });
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

  ipcMain.handle(IPC.GIT_IS_REPO, async (_event, directory: string) => isGitRepo(directory));

  ipcMain.handle(IPC.GIT_WORKTREE_ADD, async (_event, opts: { sourceRepo: string; worktreePath: string; branch: string }) => {
    log.info('Git worktree add', opts);
    return gitWorktreeAdd(opts);
  });

  ipcMain.handle(IPC.GIT_WORKTREE_REMOVE, async (_event, opts: { sourceRepo: string; worktreePath: string; force?: boolean }) => {
    log.info('Git worktree remove', opts);
    return gitWorktreeRemove(opts);
  });

  // === Vault handlers ===

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

  // === Update check ===

  ipcMain.handle(IPC.UPDATE_CHECK, async () => {
    const { checkForUpdates } = await import('../update/update-checker');
    return checkForUpdates();
  });

  ipcMain.handle(IPC.UPDATE_OPEN_RELEASE_PAGE, async (_event, url: string) => {
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' || u.host !== 'github.com' || !u.pathname.startsWith('/maxthomas95/tether/')) {
        log.warn('Refusing to open non-release URL', { url });
        return;
      }
    } catch {
      log.warn('Refusing to open malformed URL', { url });
      return;
    }
    await shell.openExternal(url);
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

  // === Quota ===

  quotaService.onUpdate((info: QuotaInfo) => {
    send(IPC.QUOTA_UPDATED, info);
  });

  ipcMain.handle(IPC.QUOTA_GET, async (): Promise<QuotaInfo> => {
    return quotaService.getQuota();
  });

  ipcMain.handle(IPC.QUOTA_REFRESH, async (): Promise<QuotaInfo> => {
    return quotaService.fetchQuota();
  });

  ipcMain.handle(IPC.QUOTA_SET_ENABLED, async (_event, enabled: boolean): Promise<void> => {
    quotaService.setEnabled(enabled);
  });

  // === Usage tracking ===

  usageService.onUpdate((info: UsageInfo) => {
    send(IPC.USAGE_UPDATED, info);
  });

  ipcMain.handle(IPC.USAGE_GET_SESSION, async (_event, claudeSessionId: string): Promise<SessionUsage | null> => {
    return usageService.getSessionUsage(claudeSessionId);
  });

  ipcMain.handle(IPC.USAGE_GET_ALL, async (): Promise<UsageInfo> => {
    return usageService.getAll();
  });

  ipcMain.handle(IPC.USAGE_REFRESH, async (_event, claudeSessionId?: string): Promise<UsageInfo> => {
    return usageService.refresh(claudeSessionId);
  });

  // === SSH known hosts ===

  ipcMain.handle(IPC.KNOWN_HOSTS_LIST, async (): Promise<KnownHostInfo[]> => {
    return knownHostsRepo.listKnownHosts().map((h) => ({
      id: h.id,
      hostKey: h.hostKey,
      keyHash: h.keyHash,
      keyType: h.keyType,
      trustedAt: h.trustedAt,
      firstSeen: h.firstSeen,
    }));
  });

  ipcMain.handle(IPC.KNOWN_HOSTS_DELETE, async (_event, id: string): Promise<void> => {
    log.info('Revoking known host', { id });
    knownHostsRepo.deleteKnownHost(id);
  });
}
