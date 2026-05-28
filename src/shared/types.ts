import type { CliToolId } from './cli-tools';
import type { KeybindingOverrides } from './keybindings';

export type { CliToolId };
export type SessionState = 'starting' | 'running' | 'waiting' | 'idle' | 'stopped' | 'dead';
/**
 * Sub-state for `state === 'waiting'`. `'permission'` indicates the CLI is
 * blocked on a permission prompt (driven by Claude's `Notification` hook
 * with notification_type=permission_prompt). `'idle'` covers turn-complete,
 * idle nudge, and the byte-level silence fallback. Undefined when state
 * isn't `'waiting'`.
 */
export type WaitingReason = 'idle' | 'permission';
export type EnvironmentType = 'local' | 'ssh' | 'coder';
export type GitProviderType = 'gitea' | 'ado' | 'github';

export interface VaultConfig {
  enabled: boolean;
  addr: string;
  role: string;
  mount: string;
  namespace?: string;
}

export interface VaultStatus {
  enabled: boolean;
  loggedIn: boolean;
  identity?: string;
  expiresAt?: string;
}

export interface VaultPreflightResult {
  /** True when at least one resolved value references Vault AND Vault is configured but not logged in. */
  needsLogin: boolean;
  /** Short human-readable explanation of why login is needed. Present only when needsLogin is true. */
  reason?: string;
}

export interface VaultExpiryWarning {
  expiresAt: string;
}

export interface VaultPlaintextSecret {
  source: 'sshPassword' | 'gitProvider' | 'envVar' | 'envEnvVar';
  // For sshPassword/envEnvVar: the environment id
  // For gitProvider: the provider id
  // For envVar (default): empty
  sourceId?: string;
  // For envVar/envEnvVar: the env var key
  key?: string;
  // Display name for UI
  displayName: string;
  // Suggested vault ref for the migration UI
  suggestedRef: string;
}

export interface MigrateSecretOptions {
  source: VaultPlaintextSecret['source'];
  sourceId?: string;
  key?: string;
  targetRef: string;
}

export interface GitProviderInfo {
  id: string;
  name: string;
  type: GitProviderType;
  baseUrl: string;
  organization?: string;
  /** ADO only: pre-fills the project picker when creating a new repo. */
  defaultProject?: string;
  hasToken: boolean;
  /** When true, the stored token is a `vault://...` reference, not a literal secret. */
  tokenIsVaultRef?: boolean;
  /** The vault reference itself (only set when tokenIsVaultRef is true). Safe to show in UI. */
  tokenVaultRef?: string;
}

export interface AdoProjectInfo {
  id: string;
  name: string;
  description: string;
}

export interface CreateRepoOptions {
  name: string;
  description?: string;
  isPrivate: boolean;
  /** ADO only: project to create the repo under. Required for ADO. */
  adoProject?: { id: string; name: string };
}

export interface GitRepoInfo {
  fullName: string;
  cloneUrl: string;
  description: string;
  defaultBranch: string;
  isPrivate: boolean;
}

export interface CloneProgressInfo {
  phase: 'counting' | 'compressing' | 'receiving' | 'resolving' | 'done' | 'error';
  percent: number;
  message: string;
}

export interface CreateGitProviderOptions {
  name: string;
  type: GitProviderType;
  baseUrl: string;
  organization?: string;
  /** ADO only: pre-fills the project picker when creating a new repo. */
  defaultProject?: string;
  token: string;
}

export interface CoderConfig {
  /** Path to the `coder` CLI binary. Defaults to `coder` (must be on PATH). */
  binaryPath?: string;
}

export interface CoderWorkspace {
  name: string;
  owner: string;
  status: string;
}

export interface CoderTemplate {
  name: string;
  displayName: string;
  description: string;
  activeVersionId: string;
}

export interface CoderTemplateParam {
  name: string;
  displayName: string;
  description: string;
  type: string;
  defaultValue: string;
  required: boolean;
  options: Array<{ name: string; value: string }>;
}

export interface CreateCoderWorkspaceOptions {
  environmentId: string;
  templateName: string;
  workspaceName: string;
  parameters?: Record<string, string>;
}

export interface EnvironmentInfo {
  id: string;
  name: string;
  type: EnvironmentType;
  config: Record<string, unknown>;
  envVars: Record<string, string>;
  sessionCount: number;
}

export interface SessionInfo {
  id: string;
  environmentId: string | null;
  cliTool?: CliToolId;
  /** Binary name when cliTool is 'custom'. */
  customCliBinary?: string;
  label: string;
  workingDir: string;
  state: SessionState;
  /** Discriminator for `state === 'waiting'`. See WaitingReason for details. */
  waitingReason?: WaitingReason;
  pid?: number;
  createdAt: string;
  /** Tool-native session id used for resume on the next launch. */
  toolSessionId?: string;
  /** Legacy Claude Code session id alias. */
  claudeSessionId?: string;
  /** True if this session was started by resuming a prior tool transcript. */
  resumed?: boolean;
  /** Source repo path when this session was created as a Tether-managed worktree. */
  worktreeOf?: string;
  /**
   * When true, Tether wires the `tether-helm` MCP into this session's launch
   * so the user's skill can call `spawn_session` to dispatch child sessions.
   * Takes effect at session spawn — toggling mid-session requires a restart.
   */
  helmEnabled?: boolean;
  /**
   * Id of the Helm session that dispatched this one. Set only on children
   * created via the `spawn_session` bridge call. Used to render the 🪝 badge
   * so users can see at a glance which sessions were spawned vs. user-created.
   */
  parentSessionId?: string;
  /**
   * Per-session terminal font-size override (Ctrl+wheel on the pane). Renderer-only:
   * not persisted in the session row, falls back to the global default at next launch.
   */
  fontSize?: number;
  /**
   * When true, this session is opted out of desktop notifications regardless
   * of the global prefs. Set via the session row's context-menu "Mute
   * notifications" toggle. Runtime-only — sessions are recreated on app
   * restart, so mute defaults to off for fresh sessions.
   */
  notificationsMuted?: boolean;
}

/**
 * User preferences for desktop notifications on session state transitions.
 * Only `onWaiting` defaults on — the other transitions are opt-in via Settings
 * or the Setup Wizard. The service computes effective firing as
 * `prefs[transition] && !focusedAndSuppressed && !session.notificationsMuted`.
 */
export interface NotificationPrefs {
  /** Fire when a session enters `waiting` (turn complete / awaiting input). */
  onWaiting: boolean;
  /** Fire when a session enters `idle` (silence past the idle timeout). */
  onIdle: boolean;
  /** Fire when a session exits with a non-zero code or otherwise errors. */
  onError: boolean;
  /** Fire when a session emits an ASCII BEL byte (\x07). */
  onBell: boolean;
  /** When true, suppress notifications while the main window is focused. */
  suppressWhenFocused: boolean;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  onWaiting: true,
  onIdle: false,
  onError: false,
  onBell: false,
  suppressWhenFocused: true,
};

export interface CreateSessionOptions {
  workingDir: string;
  label?: string;
  environmentId?: string;
  /** CLI tool to run. Defaults to 'claude' when omitted. */
  cliTool?: CliToolId;
  /** Binary name for 'custom' cliTool (e.g. 'my-cli'). */
  customCliBinary?: string;
  env?: Record<string, string>;
  cliArgs?: string[];
  /** Inherited flags the user explicitly disabled for this session. */
  disabledInheritedFlags?: string[];
  /** When set, launch the selected CLI tool by resuming this tool-native session id. */
  resumeToolSessionId?: string;
  /** Legacy alias for Claude Code resume. */
  resumeClaudeSessionId?: string;
  profileId?: string;
  /**
   * When set (Coder only), the transport runs `git clone <cloneUrl> <workingDir>`
   * inside the workspace before `cd`-ing and launching the selected CLI. Lets the
   * interactive PTY handle clone output, errors, and auth prompts inline.
   */
  cloneUrl?: string;
  /** When set, marks this session as a Tether-managed worktree of the given source repo. */
  worktreeOf?: string;
  /**
   * Initial prompt passed as the CLI tool's final positional arg. For Claude,
   * `claude [flags] "<prompt>"` starts the interactive session with this as the
   * first user message. Used by Helm-dispatched child sessions to receive their
   * brief without the caller having to inject keystrokes post-boot.
   */
  initialPrompt?: string;
  /**
   * When true, wire the `tether-helm` MCP into this session at spawn. Requires
   * the global `allowHelm` setting to also be true; otherwise silently ignored.
   */
  helmEnabled?: boolean;
  /** Parent Helm session id when this session is a Helm-dispatched child. */
  parentSessionId?: string;
}

export interface LaunchProfileInfo {
  id: string;
  name: string;
  envVars: Record<string, string>;
  cliFlagsPerTool?: Partial<Record<CliToolId, string[]>>;
  cliFlags: string[];
  isDefault: boolean;
}

export interface CreateLaunchProfileOptions {
  name: string;
  envVars?: Record<string, string>;
  cliFlagsPerTool?: Partial<Record<CliToolId, string[]>>;
  cliFlags?: string[];
  isDefault?: boolean;
}

export interface TranscriptInfo {
  /** Claude session UUID — also the JSONL filename stem. */
  id: string;
  /** Last-modified timestamp of the JSONL file (ISO). */
  mtime: string;
  /** First user prompt from the transcript, truncated. Empty if not found. */
  preview: string;
  cliTool?: CliToolId;
  sourcePath?: string;
}

export interface UpdateCheckResult {
  updateAvailable: boolean;
  latestVersion: string;
  latestTag: string;
  releaseUrl: string;
  currentVersion: string;
  error?: string;
}

export interface SessionExitInfo {
  exitCode: number;
  signal?: string;
}

export interface QuotaWindow {
  utilization: number | null;
  resetsAt: string | null;
}

export interface CodexQuotaWindow {
  usedPercent: number | null;
  resetAt: string | null;
}

export interface CodexQuota {
  primary: CodexQuotaWindow;
  secondary: CodexQuotaWindow;
  planType: string | null;
  error: string | null;
}

export interface QuotaInfo {
  fiveHour: QuotaWindow;
  sevenDay: QuotaWindow;
  subscriptionType: string | null;
  rateLimitTier: string | null;
  lastUpdated: string | null;
  error: string | null;
  codex: CodexQuota | null;
}

export interface UsageModelBreakdown {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cost: number;
}

export interface SessionUsage {
  /** Session identifier — Claude UUID or Crush id. */
  sessionId: string;
  /** Which CLI tool produced this usage data. */
  cliTool: CliToolId;
  /**
   * Tether environment id this session ran under, when known. Backfilled
   * sessions (out-of-band Claude/Codex transcripts) have no associated
   * environment and surface as "Unattributed" in the UI.
   */
  environmentId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalCost: number;
  models: UsageModelBreakdown[];
  messageCount: number;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
  parsedByteOffset: number;
}

export interface EnvironmentUsage {
  /** null = the "Unattributed" bucket for sessions with no environment. */
  environmentId: string | null;
  totalCost: number;
  sessionCount: number;
  totalTokens: number;
}

export interface CliToolUsage {
  cliTool: CliToolId;
  totalCost: number;
  sessionCount: number;
  totalTokens: number;
}

export interface DailyCliToolUsage {
  cliTool: CliToolId;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  sessionCount: number;
}

export interface DailyUsage {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalCost: number;
  sessionCount: number;
  /**
   * Per-CLI-tool breakdown for this day. Optional for back-compat with any
   * persisted UsageInfo snapshots that predate this field.
   */
  byCliTool?: DailyCliToolUsage[];
}

export interface UsageInfo {
  sessions: Record<string, SessionUsage>;
  daily: DailyUsage[];
  /** Per-environment cost rollup, sorted by totalCost desc. Includes the null-id "Unattributed" bucket if any. */
  byEnvironment: EnvironmentUsage[];
  /** Per-CLI-tool cost rollup, sorted by totalCost desc. Every session has a cliTool, so no null bucket. */
  byCliTool: CliToolUsage[];
  totalCost: number;
  lastUpdated: string | null;
}

export type UsageExportFormat = 'csv' | 'json';

export interface UsageExportResult {
  /** True when a file was written; false on user cancel. */
  ok: boolean;
  /** Absolute path written. Present when ok=true. */
  filePath?: string;
  /** Number of sessions included in the export. Present when ok=true. */
  sessionCount?: number;
  /** Error detail when the write itself failed (vs. user cancel). */
  error?: string;
}

export interface RepoGroupPref {
  environmentId: string;
  workingDir: string;
  pinned: boolean;
  sortOrder: number;
}

/**
 * User-chosen ordering of sessions within a single repo group. The renderer
 * sorts sessions in `byDir` by `orderedIds.indexOf(id)` (missing → end), so
 * new sessions naturally append and removed sessions drop out without any
 * cleanup pass.
 */
export interface SessionOrderPref {
  environmentId: string;
  workingDir: string;
  orderedIds: string[];
}

export interface KnownHostInfo {
  id: string;
  hostKey: string;
  /** OpenSSH SHA256 fingerprint body; old stored rows may still be legacy hex. */
  keyHash: string;
  keyType: string;
  trustedAt: string;
  firstSeen: string;
}

export interface HostVerifyRequest {
  token: string;
  host: string;
  port: number;
  username?: string;
  /** OpenSSH SHA256 fingerprint body, displayed as `SHA256:<value>`. */
  keyHash: string;
}

export interface DiagnosticsExportResult {
  ok: boolean;
  /** Absolute path to the written zip when ok is true. */
  path?: string;
  /** Total bytes written. */
  bytes?: number;
  /** File names included in the zip. */
  files?: string[];
  /** Reason for failure when ok is false. `'cancelled'` means the user dismissed the save dialog. */
  error?: string;
}

export interface OpenFolderResult {
  ok: boolean;
  /** Absolute path of the folder that was opened (or attempted) — useful for showing in the UI. */
  path?: string;
  /** Error string returned by `shell.openPath` when ok is false. */
  error?: string;
}

export interface CreateEnvironmentOptions {
  name: string;
  type: EnvironmentType;
  config?: Record<string, unknown>;
  envVars?: Record<string, string>;
}

export interface TetherAPI {
  platform: string;
  homeDir: string;
  session: {
    create(opts: CreateSessionOptions): Promise<SessionInfo>;
    vaultPreflight(opts: CreateSessionOptions): Promise<VaultPreflightResult>;
    list(): Promise<SessionInfo[]>;
    stop(sessionId: string): Promise<void>;
    kill(sessionId: string): Promise<void>;
    rename(sessionId: string, label: string): Promise<void>;
    remove(sessionId: string): Promise<void>;
    setHelmEnabled(sessionId: string, enabled: boolean): Promise<void>;
    sendInput(sessionId: string, data: string): void;
    resize(sessionId: string, cols: number, rows: number): void;
    onData(callback: (sessionId: string, data: string) => void): () => void;
    onStateChange(callback: (sessionId: string, state: SessionState, waitingReason?: WaitingReason) => void): () => void;
    onExited(callback: (sessionId: string, exitInfo: SessionExitInfo) => void): () => void;
    onUpdated(callback: (sessionId: string, info: SessionInfo) => void): () => void;
    /**
     * Fires when a session is created in the main process without the renderer
     * initiating it — currently only Helm-dispatched children. User-initiated
     * creates arrive as the return value of `session.create` so they don't
     * fire this event (avoids double-appending to the sidebar).
     */
    onCreated(callback: (sessionId: string, info: SessionInfo) => void): () => void;
  };
  environment: {
    list(): Promise<EnvironmentInfo[]>;
    create(opts: CreateEnvironmentOptions): Promise<EnvironmentInfo>;
    update(id: string, opts: Partial<CreateEnvironmentOptions>): Promise<void>;
    delete(id: string): Promise<void>;
  };
  profile: {
    list(): Promise<LaunchProfileInfo[]>;
    create(opts: CreateLaunchProfileOptions): Promise<LaunchProfileInfo>;
    update(id: string, opts: Partial<CreateLaunchProfileOptions>): Promise<void>;
    delete(id: string): Promise<void>;
  };
  dialog: {
    openDirectory(): Promise<string | null>;
  };
  config: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    getDefaultEnvVars(): Promise<Record<string, string>>;
    setDefaultEnvVars(vars: Record<string, string>): Promise<void>;
    getDefaultCliFlags(): Promise<string[]>;
    setDefaultCliFlags(flags: string[]): Promise<void>;
    getDefaultCliFlagsPerTool(): Promise<Partial<Record<CliToolId, string[]>>>;
    setDefaultCliFlagsForTool(toolId: CliToolId, flags: string[]): Promise<void>;
  };
  titlebar: {
    updateOverlay(color: string, symbolColor: string): Promise<void>;
  };
  scanReposDir(dir: string): Promise<string[]>;
  clipboard: {
    readText(): string;
    writeText(text: string): void;
  };
  workspace: {
    save(sessions: Array<{ workingDir: string; label: string; environmentId?: string; cliTool?: string; customCliBinary?: string; toolSessionId?: string; claudeSessionId?: string; worktreeOf?: string; helmEnabled?: boolean; parentSessionId?: string }>, activeIndex: number): Promise<void>;
    load(): Promise<{ sessions: Array<{ workingDir: string; label: string; environmentId?: string; cliTool?: string; customCliBinary?: string; toolSessionId?: string; claudeSessionId?: string; worktreeOf?: string; helmEnabled?: boolean; parentSessionId?: string }>; activeIndex: number } | null>;
  };
  transcripts: {
    list(workingDir: string, cliTool?: CliToolId): Promise<TranscriptInfo[]>;
  };
  gitProvider: {
    list(): Promise<GitProviderInfo[]>;
    create(opts: CreateGitProviderOptions): Promise<GitProviderInfo>;
    update(id: string, opts: Partial<CreateGitProviderOptions>): Promise<void>;
    delete(id: string): Promise<void>;
    test(id: string): Promise<{ ok: boolean; error?: string }>;
    listRepos(providerId: string, query?: string): Promise<GitRepoInfo[]>;
    listProjects(providerId: string): Promise<AdoProjectInfo[]>;
    createRepo(providerId: string, opts: CreateRepoOptions): Promise<GitRepoInfo>;
  };
  git: {
    clone(url: string, destination: string): Promise<string>;
    init(directory: string): Promise<string>;
    createFolder(path: string, initGit: boolean): Promise<string>;
    remoteAdd(repoPath: string, remoteName: string, remoteUrl: string): Promise<void>;
    isRepo(directory: string): Promise<boolean>;
    worktreeAdd(opts: { sourceRepo: string; worktreePath: string; branch: string }): Promise<string>;
    worktreeRemove(opts: { sourceRepo: string; worktreePath: string; force?: boolean }): Promise<void>;
    onCloneProgress(cb: (info: CloneProgressInfo) => void): () => void;
  };
  docs: {
    open(target?: { page?: string; anchor?: string }): Promise<void>;
  };
  coder: {
    listWorkspaces(environmentId: string): Promise<CoderWorkspace[]>;
    listTemplates(environmentId: string): Promise<CoderTemplate[]>;
    getTemplateParams(environmentId: string, templateVersionId: string): Promise<CoderTemplateParam[]>;
    createWorkspace(opts: CreateCoderWorkspaceOptions): Promise<CoderWorkspace>;
    onCreateProgress(cb: (line: string) => void): () => void;
  };
  update: {
    check(): Promise<UpdateCheckResult>;
    openReleasePage(url: string): Promise<void>;
    onUpdateAvailable(cb: (result: UpdateCheckResult) => void): () => void;
  };
  shell: {
    openExternal(url: string): Promise<void>;
    commandExists(command: string): Promise<boolean>;
  };
  webFrame: {
    getZoomLevel(): number;
    setZoomLevel(level: number): void;
  };
  vault: {
    getConfig(): Promise<VaultConfig>;
    setConfig(config: VaultConfig): Promise<void>;
    login(): Promise<VaultStatus>;
    cancelLogin(): Promise<void>;
    logout(): Promise<void>;
    status(): Promise<VaultStatus>;
    testRef(ref: string): Promise<{ ok: boolean; error?: string }>;
    listKeys(mount: string, path: string): Promise<string[]>;
    listFields(mount: string, path: string): Promise<string[]>;
    listPlaintext(): Promise<VaultPlaintextSecret[]>;
    migrateSecret(opts: MigrateSecretOptions): Promise<void>;
    writeSecret(ref: string, value: string): Promise<void>;
    onStatusChange(cb: (status: VaultStatus) => void): () => void;
    onExpiryWarning(cb: (warning: VaultExpiryWarning) => void): () => void;
  };
  quota: {
    get(): Promise<QuotaInfo>;
    refresh(): Promise<QuotaInfo>;
    setEnabled(enabled: boolean): Promise<void>;
    onUpdate(cb: (info: QuotaInfo) => void): () => void;
  };
  repoGroup: {
    getPrefs(): Promise<RepoGroupPref[]>;
    setPrefs(environmentId: string, prefs: RepoGroupPref[]): Promise<void>;
  };
  sessionOrder: {
    getPrefs(): Promise<SessionOrderPref[]>;
    setPref(environmentId: string, workingDir: string, orderedIds: string[]): Promise<void>;
  };
  usage: {
    getSession(sessionId: string): Promise<SessionUsage | null>;
    getAll(): Promise<UsageInfo>;
    refresh(sessionId?: string): Promise<UsageInfo>;
    export(format: UsageExportFormat): Promise<UsageExportResult>;
    onUpdate(cb: (info: UsageInfo) => void): () => void;
  };
  ssh: {
    respondToHostVerify(token: string, trust: boolean): void;
    onHostVerifyRequest(cb: (req: HostVerifyRequest) => void): () => void;
  };
  knownHosts: {
    list(): Promise<KnownHostInfo[]>;
    delete(id: string): Promise<void>;
  };
  diagnostics: {
    /** Open a save dialog and write a scrubbed bundle of data.json + logs to the chosen path. */
    export(): Promise<DiagnosticsExportResult>;
    /** Reveal the user data folder (where `data.json` and other config live) in the OS file manager. */
    openUserDataFolder(): Promise<OpenFolderResult>;
    /** Reveal the Electron logs folder in the OS file manager. */
    openLogsFolder(): Promise<OpenFolderResult>;
  };
  keybindings: {
    get(): Promise<KeybindingOverrides>;
    set(overrides: KeybindingOverrides): Promise<void>;
    resetAll(): Promise<void>;
  };
  notifications: {
    getPrefs(): Promise<NotificationPrefs>;
    setPrefs(prefs: NotificationPrefs): Promise<void>;
    setSessionMuted(sessionId: string, muted: boolean): Promise<void>;
    /**
     * Fires when the user clicks a desktop notification. Renderer should
     * focus the corresponding session (and un-maximize its pane if needed).
     */
    onSessionSelect(cb: (sessionId: string) => void): () => void;
  };
}

declare global {
  var electronAPI: TetherAPI;

  interface Window {
    electronAPI: TetherAPI;
  }
}
