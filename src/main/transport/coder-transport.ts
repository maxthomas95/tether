// CoderTransport wraps `coder ssh <workspace>` in a local PTY. It's a hybrid
// of LocalTransport (node-pty spawn) and SSHTransport (command injection via
// stdin). The workspace name is passed through `options.workingDir`.
import type { SessionTransport, TransportStartOptions, TransportExitInfo } from './types';
import { createLogger } from '../logger';
import { buildRemoteBootstrap } from './remote-bootstrap';
import { loadPty } from './pty-loader';
import { buildEnvAssignments, buildRemoteCliCommand, quotePosixShellArg, quoteRemotePath } from './posix-shell';
import { assertSafeCmdExeCommand, escapeCmdExeArgForNodePty } from '../../shared/shell-quote';
import { validateGitRemoteUrl } from '../git/git-url';
import { resolveWindowsLaunch } from './win-binary-resolver';

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
  private cancelStartup: (() => void) | null = null;

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
    const cloneUrl = options.cloneUrl ? validateGitRemoteUrl(options.cloneUrl) : undefined;
    const cloneStep = cloneUrl && subDir
      ? `{ [ -d ${quotedSubDir} ] || GIT_ALLOW_PROTOCOL=https:ssh git clone -- ${quotePosixShellArg(cloneUrl)} ${quotedSubDir}; }`
      : '';
    const chain = [cloneStep, cdStep, baseCmd].filter(Boolean).join(' && ');
    const bootstrap = buildRemoteBootstrap(chain, options.exitAfterCommand);

    // Native Windows executables receive argv directly. cmd.exe is retained
    // only for batch shims and unresolved names that require its PATH/PATHEXT
    // fallback.
    const isWin32 = process.platform === 'win32';
    const plan = isWin32 ? resolveWindowsLaunch(this.binaryPath) : null;
    const shell = plan?.kind === 'direct' ? plan.file : isWin32 ? 'cmd.exe' : this.binaryPath;
    const spawnArgs = plan?.kind === 'shell'
      ? ['/d', '/c', plan.file, 'ssh', escapeCmdExeArgForNodePty(workspaceName)]
      : ['ssh', workspaceName];
    if (plan?.kind === 'shell') {
      assertSafeCmdExeCommand(plan.file, 'Coder binary');
    }
    log.info('Spawning coder ssh', { shell, binaryPath: this.binaryPath, workspaceName, hasSubDir: Boolean(subDir) });

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

    let readyBuffer = '';
    let launchSent = false;
    let finishStartup: () => void;
    let failStartup: (error: Error) => void;
    const startup = new Promise<void>((resolve, reject) => { finishStartup = resolve; failStartup = reject; });
    const startupTimer = setTimeout(() => {
      failStartup(new Error('Coder secure session setup timed out after 15s'));
      this.kill();
    }, 15_000);
    this.cancelStartup = () => {
      clearTimeout(startupTimer);
      failStartup(new Error('Coder session setup cancelled'));
    };
    this.ptyProcess.onData((data: string) => {
      if (!launchSent) {
        readyBuffer = (readyBuffer + data).slice(-64 * 1024);
        if (readyBuffer.includes(bootstrap.readyMarker)) {
          launchSent = true;
          clearTimeout(startupTimer);
          this.cancelStartup = null;
          this.ptyProcess?.write(bootstrap.payload);
          finishStartup();
        }
      }
      for (const cb of this.dataCallbacks) {
        cb(data);
      }
    });

    this.ptyProcess.onExit(({ exitCode, signal }) => {
      clearTimeout(startupTimer);
      this.cancelStartup = null;
      if (!launchSent) failStartup(new Error('Coder exited before secure session setup completed'));
      this._connected = false;
      this.ptyProcess = null;
      const info: TransportExitInfo = { exitCode, signal: signal?.toString() };
      for (const cb of this.exitCallbacks) {
        cb(info);
      }
    });

    // This first command is secret-free; wait for confirmed echo-off before payload.
    this.ptyProcess.write(bootstrap.command);
    await startup;
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
    this.kill();
  }

  kill(): void {
    this.cancelStartup?.();
    this.cancelStartup = null;
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
