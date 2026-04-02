export interface TransportStartOptions {
  workingDir: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  cliArgs?: string[];
}

export interface TransportExitInfo {
  exitCode: number;
  signal?: string;
}

export interface SessionTransport {
  start(options: TransportStartOptions): Promise<void>;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  stop(): Promise<void>;
  kill(): void;
  onData(callback: (data: string) => void): void;
  onExit(callback: (exitInfo: TransportExitInfo) => void): void;
  readonly connected: boolean;
  dispose(): void;
}
