export type SessionState = 'starting' | 'running' | 'waiting' | 'idle' | 'stopped' | 'dead';
export type EnvironmentType = 'local' | 'ssh' | 'coder';
export type GitProviderType = 'gitea' | 'ado';

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
  hasToken: boolean;
  /** When true, the stored token is a `vault://...` reference, not a literal secret. */
  tokenIsVaultRef?: boolean;
  /** The vault reference itself (only set when tokenIsVaultRef is true). Safe to show in UI. */
  tokenVaultRef?: string;
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
  label: string;
  workingDir: string;
  state: SessionState;
  pid?: number;
  createdAt: string;
  /** UUID passed to `claude --session-id`; used by `--resume` next launch. */
  claudeSessionId?: string;
  /** True if this session was started by resuming a prior Claude transcript. */
  resumed?: boolean;
}

export interface CreateSessionOptions {
  workingDir: string;
  label?: string;
  environmentId?: string;
  env?: Record<string, string>;
  cliArgs?: string[];
  /** When set, launch claude with `--resume <id>` instead of `--session-id <new>`. */
  resumeClaudeSessionId?: string;
  profileId?: string;
}

export interface LaunchProfileInfo {
  id: string;
  name: string;
  envVars: Record<string, string>;
  cliFlags: string[];
  isDefault: boolean;
}

export interface CreateLaunchProfileOptions {
  name: string;
  envVars?: Record<string, string>;
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
    list(): Promise<SessionInfo[]>;
    stop(sessionId: string): Promise<void>;
    kill(sessionId: string): Promise<void>;
    rename(sessionId: string, label: string): Promise<void>;
    remove(sessionId: string): Promise<void>;
    sendInput(sessionId: string, data: string): void;
    resize(sessionId: string, cols: number, rows: number): void;
    onData(callback: (sessionId: string, data: string) => void): () => void;
    onStateChange(callback: (sessionId: string, state: SessionState) => void): () => void;
    onExited(callback: (sessionId: string, exitCode: number) => void): () => void;
    onLabelChanged(callback: (sessionId: string, label: string) => void): () => void;
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
    save(sessions: Array<{ workingDir: string; label: string; environmentId?: string; claudeSessionId?: string }>, activeIndex: number): Promise<void>;
    load(): Promise<{ sessions: Array<{ workingDir: string; label: string; environmentId?: string; claudeSessionId?: string }>; activeIndex: number } | null>;
  };
  transcripts: {
    list(workingDir: string): Promise<TranscriptInfo[]>;
  };
  gitProvider: {
    list(): Promise<GitProviderInfo[]>;
    create(opts: CreateGitProviderOptions): Promise<GitProviderInfo>;
    update(id: string, opts: Partial<CreateGitProviderOptions>): Promise<void>;
    delete(id: string): Promise<void>;
    test(id: string): Promise<{ ok: boolean; error?: string }>;
    listRepos(providerId: string, query?: string): Promise<GitRepoInfo[]>;
  };
  git: {
    clone(url: string, destination: string): Promise<string>;
    init(directory: string): Promise<string>;
    onCloneProgress(cb: (info: CloneProgressInfo) => void): () => void;
  };
  docs: {
    open(): Promise<void>;
  };
  coder: {
    listWorkspaces(environmentId: string): Promise<CoderWorkspace[]>;
  };
  vault: {
    getConfig(): Promise<VaultConfig>;
    setConfig(config: VaultConfig): Promise<void>;
    login(): Promise<VaultStatus>;
    logout(): Promise<void>;
    status(): Promise<VaultStatus>;
    testRef(ref: string): Promise<{ ok: boolean; error?: string }>;
    listKeys(mount: string, path: string): Promise<string[]>;
    listPlaintext(): Promise<VaultPlaintextSecret[]>;
    migrateSecret(opts: MigrateSecretOptions): Promise<void>;
    writeSecret(ref: string, value: string): Promise<void>;
    onStatusChange(cb: (status: VaultStatus) => void): () => void;
  };
}

declare global {
  interface Window {
    electronAPI: TetherAPI;
  }
}
