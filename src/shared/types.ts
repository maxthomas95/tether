export type SessionState = 'starting' | 'running' | 'waiting' | 'idle' | 'stopped' | 'dead';
export type EnvironmentType = 'local' | 'ssh' | 'coder';

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
}

export interface CreateSessionOptions {
  workingDir: string;
  label?: string;
  environmentId?: string;
  env?: Record<string, string>;
  cliArgs?: string[];
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
  };
  environment: {
    list(): Promise<EnvironmentInfo[]>;
    create(opts: CreateEnvironmentOptions): Promise<EnvironmentInfo>;
    update(id: string, opts: Partial<CreateEnvironmentOptions>): Promise<void>;
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
  };
  scanReposDir(dir: string): Promise<string[]>;
  clipboard: {
    readText(): string;
    writeText(text: string): void;
  };
  workspace: {
    save(sessions: Array<{ workingDir: string; label: string; environmentId?: string }>, activeIndex: number): Promise<void>;
    load(): Promise<{ sessions: Array<{ workingDir: string; label: string; environmentId?: string }>; activeIndex: number } | null>;
  };
}

declare global {
  interface Window {
    electronAPI: TetherAPI;
  }
}
