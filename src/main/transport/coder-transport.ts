// CoderTransport wraps `coder ssh <workspace>` in a local PTY. It's a hybrid
// of LocalTransport (node-pty spawn) and SSHTransport (command injection via
// stdin). The workspace name is passed through `options.workingDir`.
import type { SessionTransport, TransportStartOptions, TransportExitInfo } from './types';
import { createLogger } from '../logger';

const log = createLogger('coder-pty');

// POSIX single-quote shell escape: wrap in single quotes and replace any
// embedded ' with '\''. Handles every metacharacter except `'` itself.
const shq = (s: string): string => `'${s.replaceAll("'", String.raw`'\''`)}'`;

// Preserve `~` / `~/` expansion by keeping the tilde literal (unquoted) and
// single-quoting only the remainder of the path.
const quotePath = (p: string): string => {
  if (p === '~') return '~';
  if (p.startsWith('~/')) return '~/' + shq(p.slice(2));
  return shq(p);
};

let ptyModule: typeof import('node-pty') | null = null;

function getPty(): typeof import('node-pty') {
  if (!ptyModule) {
    ptyModule = require('node-pty');
  }
  return ptyModule!;
}

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
    const pty = getPty();

    // workingDir holds the workspace name, optionally with a subdirectory
    // inside the workspace separated by `::`. The subdir is cd'd into before
    // launching claude so cloned-repo sessions open in the repo dir.
    const raw = options.workingDir.trim();
    if (!raw) {
      throw new Error('CoderTransport: workspace name (workingDir) is required');
    }
    const sepIdx = raw.indexOf('::');
    const workspaceName = sepIdx >= 0 ? raw.slice(0, sepIdx) : raw;
    const subDir = sepIdx >= 0 ? raw.slice(sepIdx + 2) : '';

    // On Windows, node-pty's CreateProcess call doesn't resolve PATHEXT, so
    // bare names like "coder" (which is really "coder.cmd" or "coder.exe")
    // fail with "File not found". Wrap in cmd.exe /c to let the shell do the
    // resolution — same pattern LocalTransport uses for `claude`.
    const shell = process.platform === 'win32' ? 'cmd.exe' : this.binaryPath;
    const spawnArgs = process.platform === 'win32'
      ? ['/c', this.binaryPath, 'ssh', workspaceName]
      : ['ssh', workspaceName];

    log.info('Spawning coder ssh', { shell, args: spawnArgs });

    this.ptyProcess = pty.spawn(shell, spawnArgs, {
      name: 'xterm-256color',
      cols: options.cols,
      rows: options.rows,
      // cwd of the local spawn is irrelevant — coder ssh drops us into the
      // workspace's default directory inside the container.
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

    // Build the CLI launch command to run inside the remote workspace shell.
    // Uses the same env-escaping pattern as SSHTransport so env vars are injected
    // without touching shell history.
    const binary = options.binaryName || 'claude';
    const envParts = Object.entries(options.env || {})
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}=${shq(v)}`);

    const cliArgs = options.cliArgs?.join(' ') || '';
    const cliCmd = cliArgs ? `${binary} ${cliArgs}` : binary;

    const baseCmd = envParts.length > 0
      ? `env ${envParts.join(' ')} ${cliCmd}`
      : cliCmd;

    // Shell-escape the subdir so paths with spaces and metacharacters are
    // safe; quotePath keeps a leading ~ literal so remote shell expands it.
    const quotedSubDir = subDir ? quotePath(subDir) : '';
    const cdStep = subDir ? `cd ${quotedSubDir}` : '';

    // If cloneUrl is set, clone the repo — but skip if the directory already
    // exists (workspace restarts rerun startup scripts and the previous clone
    // survives).  Uses `[ -d ... ] || git clone ...` so the chain continues
    // either way: existing dir → no-op success, missing dir → clone.
    const cloneStep = options.cloneUrl && subDir
      ? `{ [ -d ${quotedSubDir} ] || git clone ${shq(options.cloneUrl)} ${quotedSubDir}; }`
      : '';

    const chain = [cloneStep, cdStep, baseCmd].filter(Boolean).join(' && ');
    const cmd = `${chain}\n`;

    // Write optimistically — node-pty buffers until the remote shell is ready.
    // The `coder ssh` handshake output flows through onData so the user sees
    // connection progress in xterm.js.
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
