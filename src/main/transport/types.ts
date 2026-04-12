export interface TransportStartOptions {
  workingDir: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  cliArgs?: string[];
  /** CLI binary to run. Defaults to 'claude' when omitted. */
  binaryName?: string;
  /**
   * Pin a Claude session UUID via `--session-id`. Used on first launch so we
   * can resume the same conversation later.
   */
  claudeSessionId?: string;
  /**
   * Resume an existing Claude conversation via `--resume <id>`. When set,
   * `--session-id` is omitted (the two flags are mutually exclusive).
   */
  resumeClaudeSessionId?: string;
  /**
   * Coder-only: if set, the transport runs `git clone <cloneUrl> <subDir>`
   * inside the workspace before cd'ing into the subdir and launching claude.
   */
  cloneUrl?: string;
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
