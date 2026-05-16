// CoderTransport wraps `coder ssh <workspace>` in a local PTY. It's a hybrid
// of LocalTransport (node-pty spawn) and SSHTransport (command injection via
// stdin). The workspace name is passed through `options.workingDir`.
import type { SessionTransport, TransportStartOptions, TransportExitInfo } from './types';
import { createLogger } from '../logger';
import { loadPty } from './pty-loader';
import { buildEnvAssignments, buildRemoteCliCommand, quotePosixShellArg, quoteRemotePath } from './posix-shell';

const log = createLogger('coder-pty');

interface IPty {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(callback: (data: string) => void): { dispose(): void };
  onExit(callback: (info: { exitCode: number; signal?: number }) => void): { dispose(): void };
}

export interface CoderTransportOptions {
  binaryPath?: string;
}

export class CoderTransport implements SessionTransport {
  private ptyProcess: IPty | null = null;
  private dataCallbacks: Array<(data: string) => void> = [];
  private exitCallbacks: Array<(info: TransportExitInfo) => void> = [];
  private _connected = false;
  private binaryPath: string;

  constructor(opts: CoderTransportOptions = {}) {
    this.binaryPath = opts.binaryPath?.trim() || 'coder';
  }

  get connected(): boolean {
    return this._connected;
  }

  async start(options: TransportStartOptions): Promise<void> {
    const pty = loadPty();

    // workingDir holds the workspace name, optionally with a subdirectory
    // inside the workspace separated by `::`.
    const raw = options.workingDir.trim();
    if (!raw) {
      throw new Error('CoderTransport: workspace name (workingDir) is required');
    }
    const sepIdx = raw.indexOf('::');
    const workspaceName = sepIdx >= 0 ? raw.slice(0, sepIdx) : raw;
    const subDir = sepIdx >= 0 ? raw.slice(sepIdx + 2) : '';

    const envParts = buildEnvAssignments(options.env || {});
    const cliCmd = buildRemoteCliCommand(options);
    const baseCmd = envParts.length > 0
      ? `env ${envParts.join(' ')} ${cliCmd}`
      : cliCmd;
    const quotedSubDir = subDir ? quoteRemotePath(subDir) : '';
    const cdStep = subDir ? `cd ${quotedSubDir}` : '';
    const cloneStep = options.cloneUrl && subDir
      ? `{ [ -d ${quotedSubDir} ] || git clone ${quotePosixShellArg(options.cloneUrl)} ${quotedSubDir}; }`
      : '';
    const chain = [cloneStep, cdStep, baseCmd].filter(Boolean).join(' && ');
    const cmd = `${chain}\n`;

    // On Windows, node-pty's CreateProcess call doesn't resolve PATHEXT, so
    // bare names like "coder" need a cmd.exe wrapper.
    const shell = process.platform === 'win32' ? 'cmd.exe' : this.binaryPath;
    const spawnArgs = process.platform === 'win32'
      ? ['/c', this.binaryPath, 'ssh', workspaceName]
      : ['ssh', workspaceName];

    log.info('Spawning coder ssh', { shell, args: spawnArgs });

    this.ptyProcess = pty.spawn(shell, spawnArgs, {
      name: 'xterm-256color',
      cols: options.cols,
      rows: options.rows,
      cwd: process.cwd(),
      env: {
        ...process.env,
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

    // Write optimistically; node-pty buffers until the remote shell is ready.
    this.ptyProcess.write(cmd);
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
