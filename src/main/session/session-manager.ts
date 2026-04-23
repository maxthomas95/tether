import { v4 as uuidv4 } from 'uuid';
import { safeStorage } from 'electron';
import { LocalTransport } from '../transport/local-transport';
import { SSHTransport } from '../transport/ssh-transport';
import { CoderTransport } from '../transport/coder-transport';
import type { SessionTransport } from '../transport/types';
import type { SSHConfig } from '../transport/ssh-transport';
import { statusDetector } from '../status/status-detector';
import { getEnvironment } from '../db/environment-repo';
import { getProfile } from '../db/profile-repo';
import { isVaultRef, resolveRef, resolveAll } from '../vault/vault-resolver';
import { transcriptExists } from '../claude/transcripts';
import { codexTranscriptExists } from '../codex/transcripts';
import { detectNewCodexSession, releaseCodexSessionClaim } from '../codex/session-watcher';
import type { SessionState, SessionInfo, CreateSessionOptions, CliToolId } from '../../shared/types';
import { getCliBinary, toolSupportsResume } from '../../shared/cli-tools';
import { setupHelmForSession, type HelmIntegration } from '../helm/integration';
import { createLogger } from '../logger';

const log = createLogger('session');
const CLI_TOOL_IDS: CliToolId[] = ['claude', 'codex', 'opencode', 'custom'];

function parseStringArray(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseCliFlagsPerTool(value: string | undefined): Partial<Record<CliToolId, string[]>> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const result: Partial<Record<CliToolId, string[]>> = {};
    for (const toolId of CLI_TOOL_IDS) {
      const flags = parsed[toolId];
      if (Array.isArray(flags)) {
        result[toolId] = flags.filter((item): item is string => typeof item === 'string');
      }
    }
    return result;
  } catch {
    return {};
  }
}

export interface SessionCallbacks {
  onData(sessionId: string, data: string): void;
  onStateChange(sessionId: string, state: SessionState): void;
  onExit(sessionId: string, exitCode: number): void;
  /**
   * Fired when non-state session metadata changes (currently: the codex
   * toolSessionId captured after spawn). Renderer uses this to keep its
   * SessionInfo in sync so the next workspace save has the real id.
   */
  onUpdate?(sessionId: string, info: SessionInfo): void;
  /**
   * Fired only when the session was created outside the renderer's session.create
   * IPC call (Helm-dispatched children). Regular sessions arrive via the IPC
   * return value, so this event is not used for them.
   */
  onCreated?(sessionId: string, info: SessionInfo): void;
}

/**
 * Helm-dispatched children need IPC-wired callbacks so they show up in the
 * sidebar just like user-initiated sessions. The IPC layer registers its
 * shared callback bundle here during boot — the helm bridge handler reuses it
 * when spawning children so we don't duplicate send() plumbing.
 */
let helmChildCallbacks: SessionCallbacks | null = null;
export function setHelmChildCallbacks(callbacks: SessionCallbacks): void {
  helmChildCallbacks = callbacks;
}

export class Session {
  readonly id: string;
  label: string;
  readonly workingDir: string;
  readonly environmentId: string | null;
  readonly cliTool: CliToolId;
  readonly customCliBinary: string | undefined;
  readonly createdAt: string;
  state: SessionState = 'starting';
  transport: SessionTransport | null = null;
  /** Tool-native session id used for resume. */
  toolSessionId: string | null = null;
  /** Legacy Claude Code session id alias. */
  claudeSessionId: string | null = null;
  /** True when this session was launched by resuming prior tool history. */
  resumed = false;
  /** When true, Helm MCP was wired at spawn — or will be on next restart. */
  helmEnabled = false;
  /** Live Helm integration (bridge + MCP config file). Null when Helm is off. */
  helmIntegration: HelmIntegration | null = null;
  /** Active codex session-id watcher, so we can cancel on removal. */
  codexDetectCancel: (() => void) | null = null;
  readonly worktreeOf: string | null;

  constructor(id: string, label: string, workingDir: string, environmentId?: string, cliTool?: CliToolId, customCliBinary?: string, worktreeOf?: string | null, helmEnabled?: boolean) {
    this.id = id;
    this.label = label;
    this.workingDir = workingDir;
    this.environmentId = environmentId || null;
    this.cliTool = cliTool || 'claude';
    this.customCliBinary = customCliBinary;
    this.helmEnabled = !!helmEnabled;
    this.createdAt = new Date().toISOString();
    this.worktreeOf = worktreeOf || null;
  }

  toInfo(): SessionInfo {
    return {
      id: this.id,
      environmentId: this.environmentId,
      cliTool: this.cliTool !== 'claude' ? this.cliTool : undefined,
      customCliBinary: this.customCliBinary,
      label: this.label,
      workingDir: this.workingDir,
      state: this.state,
      createdAt: this.createdAt,
      toolSessionId: this.toolSessionId || undefined,
      claudeSessionId: this.claudeSessionId || undefined,
      resumed: this.resumed || undefined,
      worktreeOf: this.worktreeOf || undefined,
      helmEnabled: this.helmEnabled || undefined,
    };
  }
}

/**
 * Scans the merged env cascade and SSH password that a session would use and
 * returns a short description of the first `vault://` reference found, or
 * null if none. Mirrors the assembly done in `createSession` / `createTransport`
 * but only inspects — no resolution, no side effects. Used by the preflight
 * IPC so the renderer can prompt for Vault login before `session.create` runs.
 */
export async function findVaultRefInSession(opts: CreateSessionOptions): Promise<string | null> {
  const { getDb } = await import('../db/database');
  const appEnvVars = getDb().defaultEnvVars || {};
  let envEnvVars: Record<string, string> = {};
  let sshPassword: string | undefined;
  if (opts.environmentId) {
    const envRow = getEnvironment(opts.environmentId);
    if (envRow?.env_vars) {
      try { envEnvVars = JSON.parse(envRow.env_vars); } catch { /* ignore */ }
    }
    if (envRow?.type === 'ssh' && envRow.config) {
      try {
        const raw = JSON.parse(envRow.config) as Record<string, unknown>;
        if (typeof raw.password === 'string') sshPassword = raw.password;
      } catch { /* ignore */ }
    }
  }
  let profileEnvVars: Record<string, string> = {};
  if (opts.profileId) {
    const profile = getProfile(opts.profileId);
    if (profile?.env_vars) {
      try { profileEnvVars = JSON.parse(profile.env_vars); } catch { /* ignore */ }
    }
  }
  const merged: Record<string, string> = {
    ...appEnvVars,
    ...envEnvVars,
    ...profileEnvVars,
    ...(opts.env || {}),
  };
  for (const [key, value] of Object.entries(merged)) {
    if (typeof value === 'string' && isVaultRef(value)) return `env var ${key}`;
  }
  if (sshPassword && isVaultRef(sshPassword)) return 'SSH password';
  return null;
}

async function createTransport(environmentId?: string): Promise<SessionTransport> {
  if (!environmentId) return new LocalTransport();

  const env = getEnvironment(environmentId);
  if (!env || env.type === 'local') return new LocalTransport();

  if (env.type === 'ssh') {
    const raw = JSON.parse(env.config) as Record<string, unknown>;
    // Resolve password: vault ref → resolved string, encrypted-at-rest → decrypted string
    let password = raw.password as string | undefined;
    if (typeof password === 'string' && isVaultRef(password)) {
      // Vault refs are stored as-is (encryptConfigPassword leaves them alone)
      password = await resolveRef(password);
    } else if (raw.passwordEncrypted && typeof password === 'string' && safeStorage.isEncryptionAvailable()) {
      password = safeStorage.decryptString(Buffer.from(password, 'base64'));
    }
    const config = raw as Partial<SSHConfig>;
    return new SSHTransport({
      host: config.host || 'localhost',
      port: config.port || 22,
      username: config.username || 'root',
      privateKeyPath: config.privateKeyPath,
      useAgent: config.useAgent ?? (!config.privateKeyPath && !password),
      password,
      useSudo: !!raw.useSudo,
    });
  }

  if (env.type === 'coder') {
    const raw = JSON.parse(env.config) as Record<string, unknown>;
    return new CoderTransport({
      binaryPath: typeof raw.binaryPath === 'string' ? raw.binaryPath : undefined,
    });
  }

  return new LocalTransport();
}

class SessionManager {
  private sessions = new Map<string, Session>();
  private callbacksMap = new Map<string, SessionCallbacks>();

  constructor() {
    statusDetector.onStateChange((sessionId, state) => {
      const session = this.sessions.get(sessionId);
      if (session) {
        session.state = state;
        this.callbacksMap.get(sessionId)?.onStateChange(sessionId, state);
      }
    });
  }

  async createSession(
    opts: CreateSessionOptions,
    callbacks: SessionCallbacks,
  ): Promise<Session> {
    const id = uuidv4();
    const label = opts.label || opts.workingDir.split(/[\\/]/).pop() || 'Untitled';
    const cliTool: CliToolId = opts.cliTool || 'claude';
    log.info('Creating session', { id, label, workingDir: opts.workingDir, environmentId: opts.environmentId, cliTool });
    const session = new Session(id, label, opts.workingDir, opts.environmentId, cliTool, opts.customCliBinary, opts.worktreeOf, opts.helmEnabled);
    this.sessions.set(id, session);
    this.callbacksMap.set(id, callbacks);

    statusDetector.register(id, cliTool);

    let transport: SessionTransport;
    try {
      transport = await createTransport(opts.environmentId);
    } catch (err) {
      log.error('Transport creation failed', { id, error: err instanceof Error ? err.message : String(err) });
      statusDetector.unregister(id);
      this.sessions.delete(id);
      this.callbacksMap.delete(id);
      throw err;
    }
    session.transport = transport;

    transport.onData((data: string) => {
      statusDetector.feedData(id, data);
      callbacks.onData(id, data);
    });

    transport.onExit(({ exitCode }) => {
      if (!session.transport) return;
      log.info('Session exited', { id, exitCode });
      statusDetector.markExited(id, exitCode);
      session.transport = null;
      session.helmIntegration?.cleanup();
      session.helmIntegration = null;
      callbacks.onExit(id, exitCode);
    });

    // Resolve env var cascade: app defaults -> environment -> profile -> session override
    const { getDb } = await import('../db/database');
    const appEnvVars = getDb().defaultEnvVars;
    let envEnvVars: Record<string, string> = {};
    if (opts.environmentId) {
      const envRow = getEnvironment(opts.environmentId);
      if (envRow?.env_vars) {
        try { envEnvVars = JSON.parse(envRow.env_vars); } catch { /* ignore */ }
      }
    }
    let profileEnvVars: Record<string, string> = {};
    let profileCliFlags: string[] = [];
    if (opts.profileId) {
      const profile = getProfile(opts.profileId);
      if (profile?.env_vars) {
        try { profileEnvVars = JSON.parse(profile.env_vars); } catch { /* ignore */ }
      }
      if (profile) {
        const perToolProfileFlags = parseCliFlagsPerTool(profile.cli_flags_per_tool);
        profileCliFlags = perToolProfileFlags[cliTool] || (cliTool === 'claude' ? parseStringArray(profile.cli_flags) : []);
      }
    }
    const mergedEnv: Record<string, string> = {
      ...appEnvVars,
      ...envEnvVars,
      ...profileEnvVars,
      ...(opts.env || {}),
    };

    // Resolve any vault:// refs in the merged env. Failure aborts the session.
    let resolvedEnv: Record<string, string>;
    try {
      resolvedEnv = await resolveAll(mergedEnv);
    } catch (err) {
      log.error('Env var resolution failed', { id, error: err instanceof Error ? err.message : String(err) });
      statusDetector.unregister(id);
      transport.dispose();
      this.sessions.delete(id);
      this.callbacksMap.delete(id);
      throw err;
    }

    // Resolve CLI flags: tool-scoped app defaults + profile + session-specific
    const perToolFlags = getDb().defaultCliFlagsPerTool || {};
    const appCliFlags = perToolFlags[cliTool] || [];
    let resolvedCliArgs = [...appCliFlags, ...profileCliFlags, ...(opts.cliArgs || [])];
    if (opts.disabledInheritedFlags?.length) {
      const disabled = new Set(opts.disabledInheritedFlags);
      resolvedCliArgs = resolvedCliArgs.filter(f => !disabled.has(f));
    }

    // Wire the Helm MCP for this session if both the global Allow Helm setting
    // AND the per-session flag are on. Only Claude Code understands --mcp-config
    // today; silently skip for other CLIs so the session still launches.
    const allowHelm = getDb().config?.allowHelm === 'true';
    if (session.helmEnabled && allowHelm && cliTool === 'claude') {
      try {
        session.helmIntegration = await setupHelmForSession(id, {
          spawn_session: async (params) => {
            const childOpts: CreateSessionOptions = {
              workingDir: typeof params.workingDir === 'string' && params.workingDir
                ? params.workingDir
                : opts.workingDir,
              label: typeof params.label === 'string' ? params.label : undefined,
              environmentId: typeof params.environmentId === 'string' ? params.environmentId : undefined,
              cliTool: 'claude',
              initialPrompt: typeof params.initialPrompt === 'string' ? params.initialPrompt : undefined,
              cliArgs: [
                ...(Array.isArray(params.cliFlags) ? params.cliFlags.filter((f): f is string => typeof f === 'string') : []),
                ...(params.autoMode === true ? ['--dangerously-skip-permissions'] : []),
              ],
              env: params.envVars && typeof params.envVars === 'object'
                ? Object.fromEntries(
                    Object.entries(params.envVars as Record<string, unknown>)
                      .filter(([, v]) => typeof v === 'string')
                      .map(([k, v]) => [k, v as string]),
                  )
                : undefined,
            };
            if (!helmChildCallbacks) {
              throw new Error('Helm child callbacks not registered');
            }
            const child = await this.createSession(childOpts, helmChildCallbacks);
            // User-initiated sessions arrive at the renderer as the return value
            // of the session.create IPC. Helm children bypass that path, so push
            // a creation event so the sidebar/termManager learns about them.
            helmChildCallbacks.onCreated?.(child.id, child.toInfo());
            return { sessionId: child.id, label: child.label };
          },
        });
        // Use =-form so the local transport's whitespace tokenizer can't split
        // the path if it contains spaces (e.g. a Windows profile with a space).
        resolvedCliArgs.push(`--mcp-config=${session.helmIntegration.mcpConfigPath}`);
        log.info('Helm MCP wired for session', { id });
      } catch (err) {
        log.warn('Helm setup failed, launching without Helm', { id, error: err instanceof Error ? err.message : String(err) });
        session.helmIntegration = null;
      }
    }

    // Resolve which CLI tool binary to launch. For 'custom', the binary
    // name comes from the session creation options.
    const binaryName = getCliBinary(cliTool, { cliBinary: opts.customCliBinary });

    // Decide on the tool-native session id. Only local sessions can verify
    // on-disk history; SSH/Coder history is remote and transport-specific.
    let toolSessionId: string | undefined;
    let resumeId: string | undefined;
    if (toolSupportsResume(cliTool) && transport instanceof LocalTransport) {
      const requestedResumeId = opts.resumeToolSessionId || (cliTool === 'claude' ? opts.resumeClaudeSessionId : undefined);
      if (cliTool === 'claude' && requestedResumeId && transcriptExists(opts.workingDir, requestedResumeId)) {
        // Resume the existing transcript and reuse the same id going forward.
        resumeId = requestedResumeId;
        toolSessionId = requestedResumeId;
        session.resumed = true;
      } else if (cliTool === 'claude') {
        // Fresh Claude session: pin a new id so we can resume it next launch.
        toolSessionId = uuidv4();
      }
      session.claudeSessionId = cliTool === 'claude' ? toolSessionId || null : null;
      if (cliTool === 'codex' && requestedResumeId && codexTranscriptExists(opts.workingDir, requestedResumeId)) {
        resumeId = requestedResumeId;
        toolSessionId = requestedResumeId;
        session.resumed = true;
      }
      session.toolSessionId = toolSessionId || null;
    }

    await transport.start({
      workingDir: opts.workingDir,
      env: resolvedEnv,
      cols: 80,
      rows: 24,
      cliArgs: resolvedCliArgs.length > 0 ? resolvedCliArgs : undefined,
      cliTool,
      binaryName,
      toolSessionId,
      resumeToolSessionId: resumeId,
      claudeSessionId: cliTool === 'claude' ? toolSessionId : undefined,
      resumeClaudeSessionId: cliTool === 'claude' ? resumeId : undefined,
      cloneUrl: opts.cloneUrl,
      initialPrompt: opts.initialPrompt,
    });

    // Codex doesn't accept a pre-assigned session id — it mints one and writes
    // it to a new jsonl under ~/.codex/sessions. Watch for that file so we can
    // resume *this* conversation on next launch instead of guessing "whatever
    // was latest in the folder".
    if (cliTool === 'codex' && transport instanceof LocalTransport && !resumeId) {
      const handle = detectNewCodexSession({ workingDir: opts.workingDir });
      session.codexDetectCancel = handle.cancel;
      handle.promise.then((detectedId) => {
        session.codexDetectCancel = null;
        if (!detectedId || !this.sessions.has(session.id)) return;
        session.toolSessionId = detectedId;
        callbacks.onUpdate?.(session.id, session.toInfo());
      });
    }

    return session;
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  listSessions(): Session[] {
    return Array.from(this.sessions.values());
  }

  renameSession(id: string, label: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.label = label;
    }
  }

  /**
   * Flip the Helm flag on a live session. Takes effect on next session spawn
   * (the MCP config is only wired when the CLI binary is launched), so the
   * caller is expected to surface a "restart session to apply" hint.
   */
  setHelmEnabled(id: string, enabled: boolean): void {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.helmEnabled === enabled) return;
    session.helmEnabled = enabled;
    this.callbacksMap.get(id)?.onUpdate?.(id, session.toInfo());
  }

  removeSession(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      log.info('Removing session', { id });
      statusDetector.unregister(id);
      session.codexDetectCancel?.();
      releaseCodexSessionClaim(session.toolSessionId);
      session.helmIntegration?.cleanup();
      session.helmIntegration = null;
      session.transport?.dispose();
      this.sessions.delete(id);
      this.callbacksMap.delete(id);
    }
  }

  writeToSession(id: string, data: string): void {
    this.sessions.get(id)?.transport?.write(data);
  }

  resizeSession(id: string, cols: number, rows: number): void {
    this.sessions.get(id)?.transport?.resize(cols, rows);
  }

  async stopSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session?.transport) {
      log.info('Stopping session', { id });
      await session.transport.stop();
    }
  }

  killSession(id: string): void {
    const session = this.sessions.get(id);
    if (session?.transport) {
      log.warn('Killing session', { id });
      session.transport.kill();
      session.transport = null;
      statusDetector.markExited(id, 1);
    }
  }

  dispose(): void {
    statusDetector.dispose();
    for (const session of this.sessions.values()) {
      session.codexDetectCancel?.();
      session.helmIntegration?.cleanup();
      session.transport?.dispose();
    }
    this.sessions.clear();
    this.callbacksMap.clear();
  }
}

export const sessionManager = new SessionManager();
