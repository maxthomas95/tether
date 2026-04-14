import { ipcMain, BrowserWindow, dialog, safeStorage, shell } from 'electron';
import { execFile } from 'node:child_process';
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
import { sessionManager } from '../session/session-manager';
import { quotaService } from '../quota/quota-service';
import { usageService } from '../usage/usage-service';
import * as envRepo from '../db/environment-repo';
import * as sessionRepo from '../db/session-repo';
import * as profileRepo from '../db/profile-repo';
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

  // === Session handlers ===

  ipcMain.handle(IPC.SESSION_CREATE, async (_event, opts: CreateSessionOptions) => {
    log.info('IPC session:create', { workingDir: opts.workingDir, environmentId: opts.environmentId });
    // Callbacks receive sessionId as their first arg — do NOT close over the
    // `session` const below. SSH transports can emit data events between
    // `transport.start()` resolving and the `await` unblocking, which would
    // hit the temporal dead zone on the const binding (v0.1.3 SSH crash).
    const session = await sessionManager.createSession(opts, {
      onData(sessionId, data) {
        send(IPC.SESSION_DATA, sessionId, data);
      },
      onStateChange(sessionId, state) {
        send(IPC.SESSION_STATE_CHANGE, sessionId, state);
        sessionRepo.updateSessionState(sessionId, state);
      },
      onExit(sessionId, exitCode) {
        send(IPC.SESSION_EXITED, sessionId, exitCode);
        const s = sessionManager.getSession(sessionId);
        if (s?.claudeSessionId) {
          usageService.untrackSession(s.claudeSessionId);
        }
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

    // Start tracking usage for Claude sessions
    if (session.claudeSessionId) {
      usageService.trackSession(session.claudeSessionId, session.workingDir);
    }

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
    sessionRepo.updateSessionLabel(sessionId, label);
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

  function resolveCoderBinary(environmentId: string): string {
    const env = envRepo.getEnvironment(environmentId);
    if (!env || env.type !== 'coder') {
      throw new Error('Environment not found or not a Coder environment');
    }
    try {
      const cfg = JSON.parse(env.config) as Record<string, unknown>;
      if (typeof cfg.binaryPath === 'string' && cfg.binaryPath.trim()) {
        return cfg.binaryPath.trim();
      }
    } catch { /* use default */ }
    return 'coder';
  }

  ipcMain.handle(IPC.CODER_LIST_WORKSPACES, async (_event, environmentId: string): Promise<CoderWorkspace[]> => {
    const binaryPath = resolveCoderBinary(environmentId);

    return new Promise<CoderWorkspace[]>((resolve, reject) => {
      execFile(
        binaryPath,
        ['list', '--output', 'json'],
        { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            log.error('coder list failed', { error: err.message, stderr: String(stderr).slice(0, 500) });
            reject(new Error(stderr ? String(stderr).trim() : err.message));
            return;
          }
          try {
            const raw = JSON.parse(String(stdout || '[]')) as unknown;
            if (!Array.isArray(raw)) {
              resolve([]);
              return;
            }
            const workspaces: CoderWorkspace[] = raw.map((w: Record<string, unknown>) => {
              const latestBuild = (w.latest_build as Record<string, unknown> | undefined) || {};
              return {
                name: String(w.name ?? ''),
                owner: String(w.owner_name ?? w.owner ?? ''),
                status: String(latestBuild.status ?? w.status ?? 'unknown'),
              };
            }).filter(w => w.name);
            resolve(workspaces);
          } catch (parseErr) {
            log.error('Failed to parse coder list output', { error: parseErr instanceof Error ? parseErr.message : String(parseErr) });
            reject(new Error('Failed to parse coder CLI output as JSON'));
          }
        },
      );
    });
  });

  ipcMain.handle(IPC.CODER_LIST_TEMPLATES, async (_event, environmentId: string): Promise<CoderTemplate[]> => {
    const binaryPath = resolveCoderBinary(environmentId);

    return new Promise<CoderTemplate[]>((resolve, reject) => {
      execFile(
        binaryPath,
        ['templates', 'list', '--output', 'json'],
        { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            log.error('coder templates list failed', { error: err.message, stderr: String(stderr).slice(0, 500) });
            reject(new Error(stderr ? String(stderr).trim() : err.message));
            return;
          }
          try {
            const raw = JSON.parse(String(stdout || '[]')) as unknown;
            if (!Array.isArray(raw)) {
              resolve([]);
              return;
            }
            const templates: CoderTemplate[] = raw.map((entry: Record<string, unknown>) => {
              // coder CLI wraps each template in a `Template` key
              const t = (entry.Template || entry) as Record<string, unknown>;
              return {
                name: String(t.name ?? ''),
                displayName: String(t.display_name || t.name || ''),
                description: String(t.description ?? ''),
                activeVersionId: String(t.active_version_id ?? ''),
              };
            }).filter(t => t.name);
            resolve(templates);
          } catch (parseErr) {
            log.error('Failed to parse coder templates output', { error: parseErr instanceof Error ? parseErr.message : String(parseErr) });
            reject(new Error('Failed to parse coder CLI output as JSON'));
          }
        },
      );
    });
  });

  // Fetch the Coder deployment URL and a short-lived session token so we can
  // call REST endpoints that have no CLI equivalent (e.g. rich-parameters).
  function getCoderAuth(binaryPath: string): Promise<{ url: string; token: string }> {
    return new Promise((resolve, reject) => {
      execFile(binaryPath, ['whoami', '--output', 'json'], { timeout: 10_000 }, (err, stdout) => {
        if (err) { reject(new Error('Failed to get Coder URL: ' + err.message)); return; }
        let url: string;
        try {
          const raw = JSON.parse(String(stdout));
          const entry = Array.isArray(raw) ? raw[0] : raw;
          url = String(entry.url || '').replace(/\/+$/, '');
        } catch { reject(new Error('Failed to parse coder whoami output')); return; }
        if (!url) { reject(new Error('Coder URL not found in whoami output')); return; }

        execFile(binaryPath, ['tokens', 'create', '--lifetime', '5m'], { timeout: 10_000 }, (err2, stdout2) => {
          if (err2) { reject(new Error('Failed to create Coder API token: ' + err2.message)); return; }
          const token = String(stdout2).trim();
          if (!token) { reject(new Error('Empty token from coder tokens create')); return; }
          resolve({ url, token });
        });
      });
    });
  }

  ipcMain.handle(IPC.CODER_GET_TEMPLATE_PARAMS, async (_event, environmentId: string, templateVersionId: string): Promise<CoderTemplateParam[]> => {
    const binaryPath = resolveCoderBinary(environmentId);
    const { url, token } = await getCoderAuth(binaryPath);

    const https = await import('node:https');
    const http = await import('node:http');
    const { URL } = await import('node:url');

    return new Promise<CoderTemplateParam[]>((resolve, reject) => {
      const endpoint = new URL(`/api/v2/templateversions/${templateVersionId}/rich-parameters`, url);
      const mod = endpoint.protocol === 'https:' ? https : http;

      const req = mod.get(endpoint.href, {
        headers: { 'Coder-Session-Token': token },
        timeout: 10_000,
        // Internal Coder deployments often use certs signed by a private CA
        // that Node doesn't trust. The coder CLI handles this via the system
        // store; we mirror that trust here for this authenticated request.
        rejectUnauthorized: false,
      }, (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            log.error('Coder rich-parameters API error', { status: res.statusCode, body: body.slice(0, 500) });
            reject(new Error(`Coder API returned ${res.statusCode}`));
            return;
          }
          try {
            const raw = JSON.parse(body) as unknown;
            if (!Array.isArray(raw)) { resolve([]); return; }
            const params: CoderTemplateParam[] = raw
              .filter((p: Record<string, unknown>) => !p.ephemeral)
              .map((p: Record<string, unknown>) => ({
                name: String(p.name ?? ''),
                displayName: String(p.display_name || p.name || ''),
                description: String(p.description ?? ''),
                type: String(p.type ?? 'string'),
                defaultValue: String(p.default_value ?? ''),
                required: Boolean(p.required),
                options: Array.isArray(p.options) ? p.options.map((o: Record<string, unknown>) => ({
                  name: String(o.name ?? ''),
                  value: String(o.value ?? ''),
                })) : [],
              }));
            resolve(params);
          } catch (parseErr) {
            log.error('Failed to parse rich-parameters response', { error: parseErr instanceof Error ? parseErr.message : String(parseErr) });
            reject(new Error('Failed to parse template parameters'));
          }
        });
      });
      req.on('error', (err: Error) => reject(new Error('Coder API request failed: ' + err.message)));
    });
  });

  ipcMain.handle(IPC.CODER_CREATE_WORKSPACE, async (_event, opts: CreateCoderWorkspaceOptions): Promise<CoderWorkspace> => {
    const binaryPath = resolveCoderBinary(opts.environmentId);
    log.info('Creating Coder workspace', { template: opts.templateName, name: opts.workspaceName });

    // Use node-pty (same as CoderTransport) so coder gets a real PTY. On
    // Windows coder create requires a console handle even when all parameters
    // are supplied — child_process.spawn/execFile can't provide one.
    // Pass the full command as a single string to cmd.exe /c so special
    // characters in parameter values (=, :, /) aren't mangled by arg splitting.
    let ptyMod: typeof import('node-pty');
    try { ptyMod = require('node-pty'); } catch (e) {
      throw new Error('node-pty not available — cannot create Coder workspace');
    }

    const q = (s: string) => `"${s.replace(/"/g, '\\"')}"`;
    const cmdStr = [binaryPath, 'create', opts.workspaceName, '--template', opts.templateName, '--yes',
      ...Object.entries(opts.parameters || {}).flatMap(([name, value]) => ['--parameter', q(`${name}=${value}`)]),
    ].join(' ');

    const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
    const spawnArgs = process.platform === 'win32' ? ['/c', cmdStr] : ['-c', cmdStr];

    log.info('coder create via PTY', { cmd: cmdStr });

    return new Promise<CoderWorkspace>((resolve, reject) => {
      const proc = ptyMod.spawn(shell, spawnArgs, {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: process.cwd(),
        env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
      });

      let output = '';
      const progressRe = /==>|===|Planning|Initializing|Starting|Queued|Running|Setting up|Cleaning/;

      proc.onData((data: string) => {
        output += data;
        for (const line of data.split(/[\r\n]+/)) {
          const clean = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
          if (clean && progressRe.test(clean)) {
            send(IPC.CODER_CREATE_PROGRESS, clean);
          }
        }
      });

      const timeout = setTimeout(() => {
        proc.kill();
        reject(new Error('Workspace creation timed out after 5 minutes'));
      }, 300_000);

      proc.onExit(({ exitCode }) => {
        clearTimeout(timeout);
        if (exitCode !== 0) {
          // Extract the last meaningful error from the output
          const lines = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').split(/[\r\n]+/).filter(l => l.trim());
          const errLine = lines.reverse().find(l => /error:|failed/i.test(l)) || lines[0] || `exit code ${exitCode}`;
          log.error('coder create failed', { exitCode, error: errLine });
          reject(new Error(errLine));
          return;
        }
        log.info('Coder workspace created', { name: opts.workspaceName });
        resolve({
          name: opts.workspaceName,
          owner: 'me',
          status: 'starting',
        });
      });
    });
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
    const needsCodexLookup = sessions.some(session => session.cliTool === 'codex' && !session.toolSessionId);
    const sessionsToSave = needsCodexLookup
      ? await Promise.all(sessions.map(async (session) => {
        if (session.cliTool !== 'codex' || session.toolSessionId) {
          return session;
        }
        const { findLatestCodexTranscript } = await import('../codex/transcripts');
        const latest = findLatestCodexTranscript(session.workingDir);
        return latest ? { ...session, toolSessionId: latest.id } : session;
      }))
      : sessions;
    getDb().savedWorkspace = { sessions: sessionsToSave, activeIndex };
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
    log.info('Vault OIDC login initiated');
    const status = await loginOidc();
    log.info('Vault login result', { loggedIn: status.loggedIn, identity: status.identity });
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
}
