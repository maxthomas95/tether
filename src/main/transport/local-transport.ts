// node-pty is imported lazily to avoid crashing the main process at startup
// if the native binary has an ABI mismatch
import type { SessionTransport, TransportStartOptions, TransportExitInfo } from './types';
import { createLogger } from '../logger';

const log = createLogger('local-pty');

let ptyModule: typeof import('node-pty') | null = null;

function getPty(): typeof import('node-pty') {
  if (!ptyModule) {
    ptyModule = require('node-pty');
  }
  return ptyModule;
}

interface IPty {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(callback: (data: string) => void): { dispose(): void };
  onExit(callback: (info: { exitCode: number; signal?: number }) => void): { dispose(): void };
}

export class LocalTransport implements SessionTransport {
  private ptyProcess: IPty | null = null;
  private dataCallbacks: Array<(data: string) => void> = [];
  private exitCallbacks: Array<(info: TransportExitInfo) => void> = [];
  private _connected = false;

  get connected(): boolean {
    return this._connected;
  }

  async start(options: TransportStartOptions): Promise<void> {
    const pty = getPty();
    const shell = process.platform === 'win32' ? 'cmd.exe' : 'bash';

    // Build the claude argv. Resume takes precedence over fresh session-id —
    // they're mutually exclusive flags on the CLI.
    const claudeArgs = [...(options.cliArgs || [])];
    if (options.resumeClaudeSessionId) {
      claudeArgs.push('--resume', options.resumeClaudeSessionId);
    } else if (options.claudeSessionId) {
      claudeArgs.push('--session-id', options.claudeSessionId);
    }

    const args = process.platform === 'win32'
      ? ['/c', 'claude', ...claudeArgs]
      : ['-c', `claude ${claudeArgs.join(' ')}`];

    log.info('Spawning local PTY', { shell, cwd: options.workingDir, args });
    this.ptyProcess = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: options.cols,
      rows: options.rows,
      cwd: options.workingDir,
      env: {
        ...process.env,
        ...options.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      } as Record<string, string>,
    });

    this._connected = true;

    this.ptyProcess.onData((data: string) => {
      for (const cb of this.dataCallbacks) {
        cb(data);
      }
    });

    this.ptyProcess.onExit(({ exitCode, signal }) => {
      this._connected = false;
      this.ptyProcess = null;
      const info: TransportExitInfo = { exitCode, signal: signal?.toString() };
      for (const cb of this.exitCallbacks) {
        cb(info);
      }
    });
  }

  write(data: string): void {
    this.ptyProcess?.write(data);
  }

  resize(cols: number, rows: number): void {
    try {
      this.ptyProcess?.resize(cols, rows);
    } catch {
      // PTY may have exited between check and resize
    }
  }

  async stop(): Promise<void> {
    if (!this.ptyProcess) return;
    this.ptyProcess.kill();
  }

  kill(): void {
    if (!this.ptyProcess) return;
    this.ptyProcess.kill();
    this._connected = false;
    this.ptyProcess = null;
  }

  onData(callback: (data: string) => void): void {
    this.dataCallbacks.push(callback);
  }

  onExit(callback: (exitInfo: TransportExitInfo) => void): void {
    this.exitCallbacks.push(callback);
  }

  dispose(): void {
    this.kill();
    this.dataCallbacks = [];
    this.exitCallbacks = [];
  }
}
