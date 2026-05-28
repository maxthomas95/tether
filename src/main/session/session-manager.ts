import { v4 as uuidv4 } from 'uuid';
import { safeStorage } from 'electron';
import { LocalTransport } from '../transport/local-transport';
import { SSHTransport } from '../transport/ssh-transport';
import { CoderTransport } from '../transport/coder-transport';
import type { SessionTransport } from '../transport/types';
import type { SSHConfig } from '../transport/ssh-transport';
import { statusDetector } from '../status/status-detector';
import { classifyExit, classifyTransition, type NotificationService, type NotifiedSession } from '../notifications/notification-service';
import { getEnvironment, listEnvironments } from '../db/environment-repo';
import { getProfile, listProfiles } from '../db/profile-repo';
import { decryptEnvVarsRecord } from '../db/secret-storage';
import { isVaultRef, resolveRef, resolveAll } from '../vault/vault-resolver';
import { transcriptExists } from '../claude/transcripts';
import { codexTranscriptExists } from '../codex/transcripts';
import { detectNewCodexSession, releaseCodexSessionClaim } from '../codex/session-watcher';
import { copilotTranscriptExists } from '../copilot/transcripts';
import { detectNewCopilotSession, releaseCopilotSessionClaim } from '../copilot/session-watcher';
import { opencodeTranscriptExists } from '../opencode/transcripts';
import { detectNewOpencodeSession, releaseOpencodeSessionClaim } from '../opencode/session-watcher';
import type { SessionState, SessionInfo, CreateSessionOptions, CliToolId, SessionExitInfo, WaitingReason } from '../../shared/types';
import { getCliBinary, toolSupportsResume } from '../../shared/cli-tools';
import { setupHelmForSession, type HelmIntegration } from '../helm/integration';
import { envForSession as hookEnvForSession } from '../cli-config/hook-service';
import { usageService } from '../usage/usage-service';
import { createCoderWorkspace, listCoderWorkspaces, listCoderTemplates, getCoderTemplateParams } from '../coder/workspace-service';
import { createLogger } from '../logger';

const log = createLogger('session');
const CLI_TOOL_IDS: CliToolId[] = ['claude', 'codex', 'copilot', 'opencode', 'custom'];

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

/**
 * Resolve the launch profile id for a Helm-dispatched child. An explicit
 * `profileId` or `profileName` wins; otherwise we fall back to the user's
 * default launch profile so API keys and env vars defined once are applied
 * automatically. `noProfile: true` opts out of the default entirely.
 */
function resolveHelmChildProfileId(params: Record<string, unknown>): string | undefined {
  if (typeof params.profileId === 'string' && params.profileId) {
    return params.profileId;
  }
  if (typeof params.profileName === 'string' && params.profileName) {
    const match = listProfiles().find(p => p.name === params.profileName);
    if (!match) {
      throw new Error(
        `Launch profile not found: ${params.profileName}. Call list_profiles to discover available profiles.`,
      );
    }
    return match.id;
  }
  if (params.noProfile === true) return undefined;
  return listProfiles().find(p => p.is_default)?.id;
}

/**
 * Project the Helm child's `envVars` param into the string/string record
 * CreateSessionOptions expects, silently dropping non-string values.
 */
function projectHelmChildEnvVars(params: Record<string, unknown>): Record<string, string> | undefined {
  if (!params.envVars || typeof params.envVars !== 'object') return undefined;
  return Object.fromEntries(
    Object.entries(params.envVars as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

/**
 * Resolve the cliTool for a Helm-dispatched child. When the caller omits
 * `cliTool`, the child inherits the parent Helm session's CLI tool — that's
 * the principle-of-least-surprise default and what makes per-call routing
 * opt-in rather than opt-out. When the caller passes a string, validate it
 * against the registry HERE (at the bridge boundary) so unknown values fail
 * with a clear error before any session-manager work happens.
 */
function resolveHelmChildCliTool(
  params: Record<string, unknown>,
  parentCliTool: CliToolId,
): CliToolId {
  if (params.cliTool === undefined || params.cliTool === null) {
    return parentCliTool;
  }
  if (typeof params.cliTool !== 'string') {
    throw new Error(
      `spawn_session: cliTool must be a string, got ${typeof params.cliTool}. ` +
      `Valid values: ${CLI_TOOL_IDS.join(', ')}.`,
    );
  }
  if (!CLI_TOOL_IDS.includes(params.cliTool as CliToolId)) {
    throw new Error(
      `spawn_session: unknown cliTool "${params.cliTool}". ` +
      `Valid values: ${CLI_TOOL_IDS.join(', ')}.`,
    );
  }
  return params.cliTool as CliToolId;
}

/**
 * Per-CLI translation of the `autoMode: true` shorthand into the flag that
 * means "yes to everything in this session" for that CLI. Mirrors the
 * registry's commonFlags but is intentionally local — autoMode is a Helm
 * concept, not a CLI feature, and the registry doesn't know about it.
 *
 * OpenCode and Custom have no documented auto-yes flag; for those, autoMode
 * is a no-op (the caller can still pass an explicit flag via cliFlags).
 */
const AUTO_MODE_FLAGS: Partial<Record<CliToolId, string>> = {
  claude: '--dangerously-skip-permissions',
  codex: '--full-auto',
  copilot: '--allow-all-tools',
};

/**
 * Build the CLI args list for a Helm child: caller-supplied flags plus the
 * CLI-appropriate auto-mode flag when `autoMode` is set.
 */
function buildHelmChildCliArgs(params: Record<string, unknown>, cliTool: CliToolId): string[] {
  const flags = Array.isArray(params.cliFlags)
    ? params.cliFlags.filter((f): f is string => typeof f === 'string')
    : [];
  if (params.autoMode === true) {
    const autoFlag = AUTO_MODE_FLAGS[cliTool];
    if (autoFlag) flags.push(autoFlag);
  }
  return flags;
}

export interface SessionCallbacks {
  onData(sessionId: string, data: string): void;
  onStateChange(sessionId: string, state: SessionState, waitingReason?: WaitingReason): void;
  onExit(sessionId: string, exitInfo: SessionExitInfo): void;
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
  waitingReason: WaitingReason | undefined = undefined;
  transport: SessionTransport | null = null;
  /** Tool-native session id used for resume. */
  toolSessionId: string | null = null;
  /** Legacy Claude Code session id alias. */
  claudeSessionId: string | null = null;
  /** True when this session was launched by resuming prior tool history. */
  resumed = false;
  /** When true, Helm MCP was wired at spawn — or will be on next restart. */
  helmEnabled = false;
  /**
   * When true, desktop notifications for this session are suppressed
   * regardless of the global prefs. Toggle via SessionManager#setNotificationsMuted.
   * Runtime-only — fresh sessions start unmuted (sessions are re-created on
   * app launch, and persisting a per-session preference would require an id
   * stable across launches, which today only `savedWorkspace` provides).
   */
  notificationsMuted = false;
  /** Live Helm integration (bridge + MCP config file). Null when Helm is off. */
  helmIntegration: HelmIntegration | null = null;
  /** Parent session id when this session was dispatched via Helm's spawn_session. */
  readonly parentSessionId: string | null;
  /** Active codex session-id watcher, so we can cancel on removal. */
  codexDetectCancel: (() => void) | null = null;
  /** Active copilot session-id watcher, so we can cancel on removal. */
  copilotDetectCancel: (() => void) | null = null;
  /** Active opencode session-id watcher, so we can cancel on removal. */
  opencodeDetectCancel: (() => void) | null = null;
  readonly worktreeOf: string | null;

  constructor(id: string, label: string, workingDir: string, options: {
    environmentId?: string;
    cliTool?: CliToolId;
    customCliBinary?: string;
    worktreeOf?: string | null;
    helmEnabled?: boolean;
    parentSessionId?: string | null;
  } = {}) {
    this.id = id;
    this.label = label;
    this.workingDir = workingDir;
    this.environmentId = options.environmentId || null;
    this.cliTool = options.cliTool || 'claude';
    this.customCliBinary = options.customCliBinary;
    this.helmEnabled = !!options.helmEnabled;
    this.createdAt = new Date().toISOString();
    this.worktreeOf = options.worktreeOf || null;
    this.parentSessionId = options.parentSessionId || null;
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
      waitingReason: this.waitingReason,
      createdAt: this.createdAt,
      toolSessionId: this.toolSessionId || undefined,
      claudeSessionId: this.claudeSessionId || undefined,
      resumed: this.resumed || undefined,
      worktreeOf: this.worktreeOf || undefined,
      helmEnabled: this.helmEnabled || undefined,
      parentSessionId: this.parentSessionId || undefined,
      notificationsMuted: this.notificationsMuted || undefined,
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
  const appEnvVars = decryptEnvVarsRecord(getDb().defaultEnvVars || {});
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

export class SessionManager {
  private sessions = new Map<string, Session>();
  private callbacksMap = new Map<string, SessionCallbacks>();
  /**
   * Optional notification sink. Wired by the main process after both the
   * session manager and the notification service exist. Left null during
   * tests so the SessionManager has zero coupling to Electron's Notification
   * API by default.
   */
  private notifier: NotificationService | null = null;

  constructor() {
    statusDetector.onStateChange((sessionId, state, waitingReason) => {
      const session = this.sessions.get(sessionId);
      if (!session) return;
      const prevState = session.state;
      session.state = state;
      session.waitingReason = state === 'waiting' ? waitingReason : undefined;
      this.callbacksMap.get(sessionId)?.onStateChange(sessionId, state, session.waitingReason);

      // Fire desktop notification for the transition, if the notifier is
      // wired. Classification + filtering live in the service — we just
      // forward the projected session.
      const kind = classifyTransition(prevState, state);
      if (kind && this.notifier) {
        this.notifier.fire(kind, this.projectForNotification(session), session.waitingReason);
      }
    });

    statusDetector.onBell((sessionId) => {
      const session = this.sessions.get(sessionId);
      if (!session || !this.notifier) return;
      this.notifier.fire('bell', this.projectForNotification(session));
    });
  }

  /**
   * Inject the notification sink. Called once at boot from `main/index.ts`
   * after the BrowserWindow exists and `createNotificationService` has run.
   * Idempotent — passing the same service twice is a no-op.
   */
  setNotifier(notifier: NotificationService | null): void {
    this.notifier = notifier;
  }

  private projectForNotification(session: Session): NotifiedSession {
    // Resolve the environment name lazily so the notification body can
    // include "SSH: prod-vm" etc. without dragging the full env row into
    // the service. Done at fire-time so renamed envs don't show stale labels.
    let environmentName: string | undefined;
    if (session.environmentId) {
      try {
        // Local import to keep the service decoupled from the DB layer's
        // module-init side effects in tests.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const repo = require('../db/environment-repo') as typeof import('../db/environment-repo');
        const env = repo.getEnvironment(session.environmentId);
        if (env && env.name !== 'Local') environmentName = env.name;
      } catch { /* ignore — degrade to label-only */ }
    }
    return {
      id: session.id,
      label: session.label,
      workingDir: session.workingDir,
      environmentName,
      notificationsMuted: session.notificationsMuted,
    };
  }

  /**
   * Flip the per-session notification mute. Takes effect immediately —
   * any in-flight notifications already fired stay visible (the OS owns
   * them at that point), but the next state transition is suppressed.
   * Pushes the new SessionInfo through the update callback so the sidebar
   * context-menu label flips ("Mute" ↔ "Unmute") without a refetch.
   */
  setNotificationsMuted(id: string, muted: boolean): void {
    const session = this.sessions.get(id);
    if (!session || session.notificationsMuted === muted) return;
    session.notificationsMuted = muted;
    this.callbacksMap.get(id)?.onUpdate?.(id, session.toInfo());
  }

  /**
   * Bridge entrypoint: a CLI hook fired and the bridge routed it here.
   * Translates the event type into a detector call. Silently no-ops when
   * the session id is unknown — the user may have killed the session
   * between the CLI firing and the helper reaching us, or this could be
   * a stray hook from a non-Tether process that happens to share the
   * env var (defense in depth: we filter by known sessions).
   *
   * Mapping rationale:
   *   - permission_prompt + elicitation_dialog → "user must act now". Plan
   *     mode confirmations and similar input boxes fire elicitation_dialog;
   *     they're the same UX category as a permission prompt — both block
   *     Claude until the user clicks something.
   *   - turn_complete + idle_prompt + elicitation_complete/response → "Claude
   *     is paused, your turn". The elicitation cycle has ended (user
   *     responded or it auto-resolved), so we drop back to plain amber.
   *   - auth_success → informational, no state change.
   */
  handleHookEvent(tetherSessionId: string, type: string): void {
    if (!this.sessions.has(tetherSessionId)) return;
    if (type === 'permission_prompt' || type === 'elicitation_dialog') {
      statusDetector.markPermissionWaiting(tetherSessionId);
      return;
    }
    if (
      type === 'turn_complete' ||
      type === 'idle_prompt' ||
      type === 'elicitation_complete' ||
      type === 'elicitation_response'
    ) {
      statusDetector.markTurnComplete(tetherSessionId);
      return;
    }
    // auth_success and any future event types fall through silently.
  }

  async createSession(
    opts: CreateSessionOptions,
    callbacks: SessionCallbacks,
  ): Promise<Session> {
    const id = uuidv4();
    const label = opts.label || opts.workingDir.split(/[\\/]/).pop() || 'Untitled';
    const cliTool: CliToolId = opts.cliTool || 'claude';
    log.info('Creating session', { id, label, workingDir: opts.workingDir, environmentId: opts.environmentId, cliTool });
    const session = new Session(id, label, opts.workingDir, {
      environmentId: opts.environmentId,
      cliTool,
      customCliBinary: opts.customCliBinary,
      worktreeOf: opts.worktreeOf,
      helmEnabled: opts.helmEnabled,
      parentSessionId: opts.parentSessionId,
    });
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

    transport.onExit((exitInfo) => {
      const { exitCode } = exitInfo;
      if (!session.transport) return;
      log.info('Session exited', { id, exitCode });
      statusDetector.markExited(id, exitCode);
      session.transport = null;
      session.helmIntegration?.cleanup();
      session.helmIntegration = null;
      callbacks.onExit(id, { exitCode, signal: exitInfo.signal });

      // Surface unexpected exits as a desktop notification. Clean exits
      // (exitCode 0) are usually user-initiated stops and are intentionally
      // quiet — the user just clicked the menu item or typed `exit`.
      const exitKind = classifyExit(exitCode);
      if (exitKind && this.notifier) {
        this.notifier.fire(exitKind, this.projectForNotification(session));
      }
    });

    // Resolve env var cascade: app defaults -> environment -> profile -> session override
    const { getDb } = await import('../db/database');
    const appEnvVars = decryptEnvVarsRecord(getDb().defaultEnvVars || {});
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
      // Layer the hook-bridge env on top, AFTER vault resolution. The hook
      // env is short-lived and process-local — we never want it to traverse
      // the vault layer (which would log/error on opaque values), and the
      // user can never override these keys via their own env config.
      const hookEnv = hookEnvForSession(id);
      Object.assign(resolvedEnv, hookEnv);
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
            if (!helmChildCallbacks) {
              throw new Error('Helm child callbacks not registered');
            }
            // Validate cliTool at the bridge boundary so unknown tools fail
            // with a clear error before any session-manager / transport work
            // happens. Default: inherit the parent Helm session's CLI tool.
            const childCliTool = resolveHelmChildCliTool(params, cliTool);
            const childOpts: CreateSessionOptions = {
              workingDir: typeof params.workingDir === 'string' && params.workingDir
                ? params.workingDir
                : opts.workingDir,
              label: typeof params.label === 'string' ? params.label : undefined,
              environmentId: typeof params.environmentId === 'string' ? params.environmentId : undefined,
              cliTool: childCliTool,
              // When the child runs the 'custom' CLI, inherit the parent's
              // custom binary so callers don't have to re-specify it (they
              // can still override via a launch profile's env/flag bundle).
              customCliBinary: childCliTool === 'custom' ? opts.customCliBinary : undefined,
              initialPrompt: typeof params.initialPrompt === 'string' ? params.initialPrompt : undefined,
              profileId: resolveHelmChildProfileId(params),
              cliArgs: buildHelmChildCliArgs(params, childCliTool),
              env: projectHelmChildEnvVars(params),
              parentSessionId: id,
            };
            const child = await this.createSession(childOpts, helmChildCallbacks);
            // User-initiated sessions arrive at the renderer as the return value
            // of the session.create IPC. Helm children bypass that path, so push
            // a creation event so the sidebar/termManager learns about them.
            helmChildCallbacks.onCreated?.(child.id, child.toInfo());
            return { sessionId: child.id, label: child.label };
          },
          create_coder_workspace: async (params) => {
            const environmentId = typeof params.environmentId === 'string' ? params.environmentId : '';
            const templateName = typeof params.templateName === 'string' ? params.templateName : '';
            const workspaceName = typeof params.workspaceName === 'string' ? params.workspaceName : '';
            if (!environmentId || !templateName || !workspaceName) {
              throw new Error('create_coder_workspace requires environmentId, templateName, and workspaceName');
            }
            const parameters = params.parameters && typeof params.parameters === 'object' && !Array.isArray(params.parameters)
              ? Object.fromEntries(
                  Object.entries(params.parameters as Record<string, unknown>)
                    .filter(([, v]) => typeof v === 'string')
                    .map(([k, v]) => [k, v as string]),
                )
              : undefined;
            const ws = await createCoderWorkspace({ environmentId, templateName, workspaceName, parameters });
            return { workspaceName: ws.name, owner: ws.owner, status: ws.status };
          },
          list_coder_workspaces: async (params) => {
            const environmentId = typeof params.environmentId === 'string' ? params.environmentId : '';
            if (!environmentId) throw new Error('list_coder_workspaces requires environmentId');
            return listCoderWorkspaces(environmentId);
          },
          list_coder_templates: async (params) => {
            const environmentId = typeof params.environmentId === 'string' ? params.environmentId : '';
            if (!environmentId) throw new Error('list_coder_templates requires environmentId');
            return listCoderTemplates(environmentId);
          },
          get_coder_template_params: async (params) => {
            const environmentId = typeof params.environmentId === 'string' ? params.environmentId : '';
            const templateVersionId = typeof params.templateVersionId === 'string' ? params.templateVersionId : '';
            if (!environmentId || !templateVersionId) {
              throw new Error('get_coder_template_params requires environmentId and templateVersionId');
            }
            return getCoderTemplateParams(environmentId, templateVersionId);
          },
          list_environments: async () => {
            // Project to a minimal, safe shape — deliberately omit config,
            // env_vars, and auth_mode so the bridge doesn't leak binary paths
            // or env-var values (which may include secrets) to the MCP child.
            return listEnvironments().map(e => ({ id: e.id, name: e.name, type: e.type }));
          },
          list_profiles: async () => {
            // Return id, name, isDefault, and the KEYS of env vars the profile
            // would apply — never the values, which may be API keys or vault
            // references. Keys are enough for a leader to reason about whether
            // a profile is the right one without ever seeing secrets.
            return listProfiles().map(p => {
              let envVarKeys: string[] = [];
              try { envVarKeys = Object.keys(JSON.parse(p.env_vars) as Record<string, string>); } catch { /* leave empty */ }
              return { id: p.id, name: p.name, isDefault: p.is_default, envVarKeys };
            });
          },
          get_session_status: async (params) => {
            const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
            if (!sessionId) throw new Error('get_session_status requires sessionId');
            const s = this.getSession(sessionId);
            if (!s) throw new Error(`Session not found: ${sessionId}`);
            return s.toInfo();
          },
          kill_session: async (params) => {
            const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
            if (!sessionId) throw new Error('kill_session requires sessionId');
            if (params.graceful === false) {
              // Explicit non-graceful request → bypass the grace period
              this.forceKill(sessionId);
            } else {
              await this.stopSession(sessionId);
            }
            return { sessionId, terminated: true };
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
      if (cliTool === 'copilot' && requestedResumeId && copilotTranscriptExists(opts.workingDir, requestedResumeId)) {
        resumeId = requestedResumeId;
        toolSessionId = requestedResumeId;
        session.resumed = true;
      }
      // OpenCode's existence check shells out to `opencode session list`, so
      // it's noticeably more expensive than reading a local file. Still worth
      // the check — passing an unknown id to `opencode --session` would create
      // an unrelated conversation rather than fail loudly.
      if (cliTool === 'opencode' && requestedResumeId && await opencodeTranscriptExists(opts.workingDir, requestedResumeId)) {
        resumeId = requestedResumeId;
        toolSessionId = requestedResumeId;
        session.resumed = true;
      }
      session.toolSessionId = toolSessionId || null;
    }

    try {
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
    } catch (err) {
      log.error('Transport start failed', { id, error: err instanceof Error ? err.message : String(err) });
      statusDetector.unregister(id);
      session.helmIntegration?.cleanup();
      session.helmIntegration = null;
      session.transport = null;
      transport.dispose();
      this.sessions.delete(id);
      this.callbacksMap.delete(id);
      throw err;
    }

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
        // Codex doesn't go through the create-time trackSession in handlers.ts
        // (the toolSessionId isn't known yet there). Hook it here so the
        // per-environment rollup attributes the cost as soon as the watcher
        // catches the new transcript — no waiting for the periodic backfill.
        usageService.trackSession(detectedId, opts.workingDir, 'codex', opts.environmentId ?? undefined);
        callbacks.onUpdate?.(session.id, session.toInfo());
      });
    }

    // Copilot mints its session UUID at spawn (the dirname under
    // ~/.copilot/session-state/). Watch for the new dir so we can resume this
    // exact conversation later instead of opening copilot's own picker.
    if (cliTool === 'copilot' && transport instanceof LocalTransport && !resumeId) {
      const handle = detectNewCopilotSession({ workingDir: opts.workingDir });
      session.copilotDetectCancel = handle.cancel;
      handle.promise.then((detectedId) => {
        session.copilotDetectCancel = null;
        if (!detectedId || !this.sessions.has(session.id)) return;
        session.toolSessionId = detectedId;
        callbacks.onUpdate?.(session.id, session.toInfo());
      });
    }

    // OpenCode also assigns its `ses_…` id at first turn. Poll its CLI to
    // capture the new id so we can attach to it next launch.
    if (cliTool === 'opencode' && transport instanceof LocalTransport && !resumeId) {
      const handle = detectNewOpencodeSession({ workingDir: opts.workingDir });
      session.opencodeDetectCancel = handle.cancel;
      handle.promise.then((detectedId) => {
        session.opencodeDetectCancel = null;
        if (!detectedId || !this.sessions.has(session.id)) return;
        session.toolSessionId = detectedId;
        // OpenCode usage is sourced from crush.db. Track here so a freshly
        // created (non-resumed) session is attributed to its environment.
        usageService.trackSession(detectedId, opts.workingDir, 'opencode', opts.environmentId ?? undefined);
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
      session.copilotDetectCancel?.();
      session.opencodeDetectCancel?.();
      if (session.cliTool === 'codex') releaseCodexSessionClaim(session.toolSessionId);
      if (session.cliTool === 'copilot') releaseCopilotSessionClaim(session.toolSessionId);
      if (session.cliTool === 'opencode') releaseOpencodeSessionClaim(session.toolSessionId);
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

  /**
   * Sessions currently in the grace period between a graceful stop() and the
   * forced kill() escalation. A second stopSession() call during this window
   * immediately escalates to kill().
   */
  private stoppingIds = new Set<string>();

  /**
   * Unified stop: tries a graceful transport.stop() first, then auto-escalates
   * to transport.kill() after ~3 seconds if the session hasn't terminated.
   *
   * If called a second time while the grace period is active, escalates to
   * kill() immediately (double-click-to-force pattern).
   */
  async stopSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session?.transport) return;

    // Second call during grace period → immediate kill
    if (this.stoppingIds.has(id)) {
      log.warn('Stop called again during grace period, escalating to kill', { id });
      this.forceKill(id);
      return;
    }

    log.info('Stopping session (graceful)', { id });
    this.stoppingIds.add(id);

    // Kick off the graceful stop (non-blocking — SSH stop sends Ctrl+C / exit
    // and resolves; local stop calls ptyProcess.kill which may resolve quickly).
    try {
      await session.transport.stop();
    } catch {
      // If the graceful stop itself throws, escalate immediately.
      if (this.stoppingIds.has(id) && session.transport) {
        log.warn('Graceful stop threw, escalating to kill', { id });
        this.forceKill(id);
      }
      return;
    }

    // If the transport already disconnected during the await, we're done.
    if (!session.transport) {
      this.stoppingIds.delete(id);
      return;
    }

    // Wait up to 3 seconds for the session to terminate on its own.
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        // Grace period expired — force-kill if still alive.
        if (this.stoppingIds.has(id) && session.transport) {
          log.warn('Grace period expired, escalating to kill', { id });
          this.forceKill(id);
        }
        resolve();
      }, 3000);

      // Early exit: transport's onExit fires during the wait → clear timer.
      const checkInterval = setInterval(() => {
        if (!session.transport) {
          clearTimeout(timer);
          clearInterval(checkInterval);
          this.stoppingIds.delete(id);
          resolve();
        }
      }, 100);
    });
  }

  /**
   * Internal forced termination. Destroys the transport, marks the session
   * exited, and cleans up the stopping state. Callers: auto-escalation from
   * stopSession and the Helm kill_session tool.
   */
  forceKill(id: string): void {
    this.stoppingIds.delete(id);
    const session = this.sessions.get(id);
    if (session?.transport) {
      log.warn('Force-killing session', { id });
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
