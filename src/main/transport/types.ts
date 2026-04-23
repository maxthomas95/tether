import type { CliToolId } from '../../shared/cli-tools';

export interface TransportStartOptions {
  workingDir: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  cliArgs?: string[];
  /** CLI tool being launched. Defaults to 'claude' when omitted. */
  cliTool?: CliToolId;
  /** CLI binary to run. Defaults to 'claude' when omitted. */
  binaryName?: string;
  /** Tool-native session id to pin when the selected CLI supports it. */
  toolSessionId?: string;
  /** Tool-native session id to resume when the selected CLI supports it. */
  resumeToolSessionId?: string;
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
   * inside the workspace before cd'ing into the subdir and launching the selected CLI.
   */
  cloneUrl?: string;
  /**
   * Passed as the CLI's final positional arg (e.g. `claude ... "<prompt>"`).
   * Appended after tokenization/shell-joining so multi-word prompts stay intact.
   */
  initialPrompt?: string;
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
