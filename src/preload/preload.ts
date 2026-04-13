import { contextBridge, ipcRenderer, clipboard } from 'electron';
import { IPC } from '../shared/constants';
import type {
  CreateSessionOptions, SessionInfo, SessionState,
  CreateEnvironmentOptions, EnvironmentInfo,
  CreateLaunchProfileOptions, LaunchProfileInfo,
  TetherAPI,
  CreateGitProviderOptions, GitProviderInfo, GitRepoInfo, CloneProgressInfo,
  UpdateCheckResult,
  VaultConfig, VaultStatus, VaultPlaintextSecret, MigrateSecretOptions,
  TranscriptInfo,
  CoderWorkspace,
} from '../shared/types';

const api: TetherAPI = {
  platform: process.platform,
  homeDir: process.env.USERPROFILE || process.env.HOME || '',

  session: {
    create: (opts: CreateSessionOptions): Promise<SessionInfo> => ipcRenderer.invoke(IPC.SESSION_CREATE, opts),
    list: (): Promise<SessionInfo[]> => ipcRenderer.invoke(IPC.SESSION_LIST),
    stop: (id: string): Promise<void> => ipcRenderer.invoke(IPC.SESSION_STOP, id),
    kill: (id: string): Promise<void> => ipcRenderer.invoke(IPC.SESSION_KILL, id),
    rename: (id: string, label: string): Promise<void> => ipcRenderer.invoke(IPC.SESSION_RENAME, id, label),
    remove: (id: string): Promise<void> => ipcRenderer.invoke(IPC.SESSION_REMOVE, id),
    sendInput: (id: string, data: string): void => { ipcRenderer.send(IPC.SESSION_INPUT, id, data); },
    resize: (id: string, cols: number, rows: number): void => { ipcRenderer.send(IPC.SESSION_RESIZE, id, cols, rows); },
    onData(cb: (id: string, data: string) => void): () => void {
      const h = (_e: Electron.IpcRendererEvent, id: string, data: string) => cb(id, data);
      ipcRenderer.on(IPC.SESSION_DATA, h);
      return () => ipcRenderer.removeListener(IPC.SESSION_DATA, h);
    },
    onStateChange(cb: (id: string, state: SessionState) => void): () => void {
      const h = (_e: Electron.IpcRendererEvent, id: string, state: SessionState) => cb(id, state);
      ipcRenderer.on(IPC.SESSION_STATE_CHANGE, h);
      return () => ipcRenderer.removeListener(IPC.SESSION_STATE_CHANGE, h);
    },
    onExited(cb: (id: string, code: number) => void): () => void {
      const h = (_e: Electron.IpcRendererEvent, id: string, code: number) => cb(id, code);
      ipcRenderer.on(IPC.SESSION_EXITED, h);
      return () => ipcRenderer.removeListener(IPC.SESSION_EXITED, h);
    },
    onLabelChanged(cb: (id: string, label: string) => void): () => void {
      const h = (_e: Electron.IpcRendererEvent, id: string, label: string) => cb(id, label);
      ipcRenderer.on(IPC.SESSION_LABEL_CHANGED, h);
      return () => ipcRenderer.removeListener(IPC.SESSION_LABEL_CHANGED, h);
    },
  },

  environment: {
    list: (): Promise<EnvironmentInfo[]> => ipcRenderer.invoke(IPC.ENV_LIST),
    create: (opts: CreateEnvironmentOptions): Promise<EnvironmentInfo> => ipcRenderer.invoke(IPC.ENV_CREATE, opts),
    update: (id: string, opts: Partial<CreateEnvironmentOptions>): Promise<void> => ipcRenderer.invoke(IPC.ENV_UPDATE, id, opts),
    delete: (id: string): Promise<void> => ipcRenderer.invoke(IPC.ENV_DELETE, id),
  },

  profile: {
    list: (): Promise<LaunchProfileInfo[]> => ipcRenderer.invoke(IPC.PROFILE_LIST),
    create: (opts: CreateLaunchProfileOptions): Promise<LaunchProfileInfo> => ipcRenderer.invoke(IPC.PROFILE_CREATE, opts),
    update: (id: string, opts: Partial<CreateLaunchProfileOptions>): Promise<void> => ipcRenderer.invoke(IPC.PROFILE_UPDATE, id, opts),
    delete: (id: string): Promise<void> => ipcRenderer.invoke(IPC.PROFILE_DELETE, id),
  },

  dialog: {
    openDirectory: (): Promise<string | null> => ipcRenderer.invoke(IPC.DIALOG_OPEN_DIRECTORY),
  },

  config: {
    get: (key: string): Promise<string | null> => ipcRenderer.invoke(IPC.CONFIG_GET, key),
    set: (key: string, value: string): Promise<void> => ipcRenderer.invoke(IPC.CONFIG_SET, key, value),
    getDefaultEnvVars: (): Promise<Record<string, string>> => ipcRenderer.invoke(IPC.CONFIG_GET_DEFAULT_ENV_VARS),
    setDefaultEnvVars: (vars: Record<string, string>): Promise<void> => ipcRenderer.invoke(IPC.CONFIG_SET_DEFAULT_ENV_VARS, vars),
    getDefaultCliFlags: (): Promise<string[]> => ipcRenderer.invoke(IPC.CONFIG_GET_DEFAULT_CLI_FLAGS),
    setDefaultCliFlags: (flags: string[]): Promise<void> => ipcRenderer.invoke(IPC.CONFIG_SET_DEFAULT_CLI_FLAGS, flags),
  },

  titlebar: {
    updateOverlay: (color: string, symbolColor: string): Promise<void> => ipcRenderer.invoke(IPC.TITLEBAR_UPDATE, color, symbolColor),
  },

  scanReposDir: (dir: string): Promise<string[]> => ipcRenderer.invoke(IPC.SCAN_REPOS_DIR, dir),

  clipboard: {
    readText: (): string => clipboard.readText(),
    writeText: (text: string): void => clipboard.writeText(text),
  },

  workspace: {
    save: (sessions: Array<{ workingDir: string; label: string; environmentId?: string; claudeSessionId?: string }>, activeIndex: number): Promise<void> =>
      ipcRenderer.invoke(IPC.WORKSPACE_SAVE, sessions, activeIndex),
    load: (): Promise<{ sessions: Array<{ workingDir: string; label: string; environmentId?: string; claudeSessionId?: string }>; activeIndex: number } | null> =>
      ipcRenderer.invoke(IPC.WORKSPACE_LOAD),
  },

  transcripts: {
    list: (workingDir: string): Promise<TranscriptInfo[]> => ipcRenderer.invoke(IPC.TRANSCRIPTS_LIST, workingDir),
  },

  gitProvider: {
    list: (): Promise<GitProviderInfo[]> => ipcRenderer.invoke(IPC.GIT_PROVIDER_LIST),
    create: (opts: CreateGitProviderOptions): Promise<GitProviderInfo> => ipcRenderer.invoke(IPC.GIT_PROVIDER_CREATE, opts),
    update: (id: string, opts: Partial<CreateGitProviderOptions>): Promise<void> => ipcRenderer.invoke(IPC.GIT_PROVIDER_UPDATE, id, opts),
    delete: (id: string): Promise<void> => ipcRenderer.invoke(IPC.GIT_PROVIDER_DELETE, id),
    test: (id: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke(IPC.GIT_PROVIDER_TEST, id),
    listRepos: (providerId: string, query?: string): Promise<GitRepoInfo[]> => ipcRenderer.invoke(IPC.GIT_PROVIDER_REPOS, providerId, query),
  },

  git: {
    clone: (url: string, destination: string): Promise<string> => ipcRenderer.invoke(IPC.GIT_CLONE, url, destination),
    init: (directory: string): Promise<string> => ipcRenderer.invoke(IPC.GIT_INIT, directory),
    onCloneProgress(cb: (info: CloneProgressInfo) => void): () => void {
      const h = (_e: Electron.IpcRendererEvent, info: CloneProgressInfo) => cb(info);
      ipcRenderer.on(IPC.GIT_CLONE_PROGRESS, h);
      return () => ipcRenderer.removeListener(IPC.GIT_CLONE_PROGRESS, h);
    },
  },

  docs: {
    open: (): Promise<void> => ipcRenderer.invoke(IPC.DOCS_OPEN),
  },

  coder: {
    listWorkspaces: (environmentId: string): Promise<CoderWorkspace[]> =>
      ipcRenderer.invoke(IPC.CODER_LIST_WORKSPACES, environmentId),
  },

  update: {
    check: (): Promise<UpdateCheckResult> => ipcRenderer.invoke(IPC.UPDATE_CHECK),
    openReleasePage: (url: string): Promise<void> => ipcRenderer.invoke(IPC.UPDATE_OPEN_RELEASE_PAGE, url),
    onUpdateAvailable(cb: (result: UpdateCheckResult) => void): () => void {
      const h = (_e: Electron.IpcRendererEvent, result: UpdateCheckResult) => cb(result);
      ipcRenderer.on(IPC.UPDATE_AVAILABLE, h);
      return () => ipcRenderer.removeListener(IPC.UPDATE_AVAILABLE, h);
    },
  },

  vault: {
    getConfig: (): Promise<VaultConfig> => ipcRenderer.invoke(IPC.VAULT_GET_CONFIG),
    setConfig: (config: VaultConfig): Promise<void> => ipcRenderer.invoke(IPC.VAULT_SET_CONFIG, config),
    login: (): Promise<VaultStatus> => ipcRenderer.invoke(IPC.VAULT_LOGIN),
    logout: (): Promise<void> => ipcRenderer.invoke(IPC.VAULT_LOGOUT),
    status: (): Promise<VaultStatus> => ipcRenderer.invoke(IPC.VAULT_STATUS),
    testRef: (ref: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke(IPC.VAULT_TEST_REF, ref),
    listKeys: (mount: string, path: string): Promise<string[]> => ipcRenderer.invoke(IPC.VAULT_LIST_KEYS, mount, path),
    listPlaintext: (): Promise<VaultPlaintextSecret[]> => ipcRenderer.invoke(IPC.VAULT_LIST_PLAINTEXT),
    migrateSecret: (opts: MigrateSecretOptions): Promise<void> => ipcRenderer.invoke(IPC.VAULT_MIGRATE_SECRET, opts),
    writeSecret: (ref: string, value: string): Promise<void> => ipcRenderer.invoke(IPC.VAULT_WRITE_SECRET, ref, value),
    onStatusChange(cb: (status: VaultStatus) => void): () => void {
      const h = (_e: Electron.IpcRendererEvent, status: VaultStatus) => cb(status);
      ipcRenderer.on(IPC.VAULT_STATUS_CHANGED, h);
      return () => ipcRenderer.removeListener(IPC.VAULT_STATUS_CHANGED, h);
    },
  },
};

contextBridge.exposeInMainWorld('electronAPI', api);
