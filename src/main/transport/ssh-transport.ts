import { StringDecoder } from 'node:string_decoder';
import type { SessionTransport, TransportStartOptions, TransportExitInfo } from './types';
import { createLogger } from '../logger';
import { verifyHost } from '../ssh/host-verifier';

const log = createLogger('ssh');

let ssh2Module: typeof import('ssh2') | null = null;

function getSsh2(): typeof import('ssh2') {
  if (!ssh2Module) {
    ssh2Module = require('ssh2');
  }
  return ssh2Module!;
}

export interface SSHConfig {
  host: string;
  port: number;
  username: string;
  privateKeyPath?: string;
  useAgent?: boolean;
  password?: string;
  useSudo?: boolean;
}

const SETUP_TIMEOUT_MS = 15_000;
const PROMPT_RE = /[$#>❯%]\s*$/;
const PASSWORD_RE = /[Pp]assword.*:\s*$/;
const FAILURE_RE = /Sorry|incorrect password|Authentication failure|not in the sudoers/i;
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
const lastNonEmptyLine = (text: string): string =>
  text.split('\n').filter(l => l.trim()).pop()?.trim() || '';

type SetupState = 'waitShell' | 'waitPassword' | 'waitElevated' | 'waitEchoOff';

interface SshSessionSetupOptions {
  stream: NodeJS.ReadWriteStream;
  cmd: string;
  useSudo: boolean;
  password?: string;
  host: string;
  resolve: () => void;
  reject: (err: Error) => void;
}

/**
 * Drives the post-connect handshake on an SSH PTY: optional `sudo -i`
 * elevation, then `stty -echo` so the kernel line discipline doesn't echo
 * our bootstrap line (which carries env values and the binary command),
 * then writes the launch command.
 */
class SshSessionSetup {
  private state: SetupState = 'waitShell';
  private buffer = '';
  private passwordSent = false;
  private settled = false;
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly opts: SshSessionSetupOptions) {
    this.timer = setTimeout(() => this.onTimeout(), SETUP_TIMEOUT_MS);
  }

  handleData(data: Buffer): void {
    if (this.settled) return;
    this.buffer += stripAnsi(data.toString('utf-8'));
    const last = lastNonEmptyLine(this.buffer);

    switch (this.state) {
      case 'waitShell': this.onShellPrompt(last); break;
      case 'waitPassword': this.onPasswordPhase(last); break;
      case 'waitElevated': this.onElevatedPhase(last); break;
      case 'waitEchoOff': this.onEchoOffPhase(last); break;
    }
  }

  private onShellPrompt(last: string): void {
    if (!PROMPT_RE.test(last)) return;
    if (this.opts.useSudo) {
      log.info('Shell prompt detected, sending sudo -i');
      this.state = 'waitPassword';
      this.buffer = '';
      this.opts.stream.write('sudo -i\n');
    } else {
      log.info('Shell prompt detected, disabling echo before launch');
      this.startEchoOff();
    }
  }

  private onPasswordPhase(last: string): void {
    if (FAILURE_RE.test(this.buffer)) {
      this.fail('Sudo authentication failed');
      return;
    }
    if (PASSWORD_RE.test(last)) {
      log.info('Password prompt detected, sending password');
      this.passwordSent = true;
      this.state = 'waitElevated';
      this.buffer = '';
      this.opts.stream.write((this.opts.password || '') + '\n');
    } else if (PROMPT_RE.test(last) && this.buffer.length > 5) {
      // NOPASSWD: root shell appeared without password prompt
      log.info('NOPASSWD sudo detected, disabling echo before launch');
      this.startEchoOff();
    }
  }

  private onElevatedPhase(last: string): void {
    if (FAILURE_RE.test(this.buffer)) {
      this.fail('Sudo authentication failed');
      return;
    }
    if (PASSWORD_RE.test(last) && this.passwordSent) {
      // Second password prompt means first password was wrong
      this.fail('Sudo authentication failed — incorrect password');
      return;
    }
    if (PROMPT_RE.test(last)) {
      log.info('Root shell prompt detected, disabling echo before launch');
      this.startEchoOff();
    }
  }

  private onEchoOffPhase(last: string): void {
    if (!PROMPT_RE.test(last)) return;
    log.info('Echo disabled, sending launch command');
    this.complete();
  }

  private startEchoOff(): void {
    this.state = 'waitEchoOff';
    this.buffer = '';
    this.opts.stream.write('stty -echo\n');
  }

  private complete(): void {
    this.settled = true;
    clearTimeout(this.timer);
    this.opts.stream.write(this.opts.cmd);
    this.opts.resolve();
  }

  private fail(message: string): void {
    this.settled = true;
    clearTimeout(this.timer);
    this.opts.reject(new Error(message));
  }

  private onTimeout(): void {
    if (this.settled) return;
    this.settled = true;
    log.error('Session setup timed out', { host: this.opts.host, state: this.state });
    const message = this.state === 'waitPassword' || this.state === 'waitElevated'
      ? 'Sudo elevation timed out after 15s'
      : 'Session setup timed out after 15s — shell prompt not detected';
    this.opts.reject(new Error(message));
  }
}

export class SSHTransport implements SessionTransport {
  private client: InstanceType<typeof import('ssh2').Client> | null = null;
  private stream: NodeJS.ReadWriteStream | null = null;
  private dataCallbacks: Array<(data: string) => void> = [];
  private exitCallbacks: Array<(info: TransportExitInfo) => void> = [];
  private _connected = false;
  private sshConfig: SSHConfig;
  /** Captured during host verification when the connection should fail with a
   *  human-friendly explanation (key changed, prompt rejected, dispatcher missing). */
  private verifyError: string | null = null;

  constructor(sshConfig: SSHConfig) {
    this.sshConfig = sshConfig;
  }

  get connected(): boolean {
    return this._connected;
  }

  async start(options: TransportStartOptions): Promise<void> {
    const { Client } = getSsh2();
    const fs = require('node:fs');

    this.client = new Client();

    log.info('Connecting SSH', { host: this.sshConfig.host, port: this.sshConfig.port, username: this.sshConfig.username });
    return new Promise<void>((resolve, reject) => {
      const connectConfig: Record<string, unknown> = {
        host: this.sshConfig.host,
        port: this.sshConfig.port || 22,
        username: this.sshConfig.username,
        keepaliveInterval: 10000,
        keepaliveCountMax: 3,
        readyTimeout: 15000,
        hostHash: 'sha256',
        hostVerifier: (key: string | Buffer, callback: (accept: boolean) => void) => {
          // With hostHash set, ssh2 hands us a hex string. Normalize to lowercase
          // so we compare deterministically with stored hashes.
          const keyHash = (typeof key === 'string' ? key : key.toString('hex')).toLowerCase();
          verifyHost(this.sshConfig.host, this.sshConfig.port || 22, keyHash, this.sshConfig.username)
            .then((result) => {
              if (!result.trust && result.reason) {
                this.verifyError = result.reason;
              }
              callback(result.trust);
            })
            .catch((err: Error) => {
              this.verifyError = err.message || 'Host key verification failed';
              callback(false);
            });
        },
      };

      // Authentication: agent, private key, or password
      if (this.sshConfig.useAgent) {
        // Windows OpenSSH agent
        connectConfig.agent = process.env.SSH_AUTH_SOCK || '\\\\.\\pipe\\openssh-ssh-agent';
      } else if (this.sshConfig.privateKeyPath) {
        try {
          connectConfig.privateKey = fs.readFileSync(this.sshConfig.privateKeyPath);
        } catch (err) {
          reject(new Error(`Failed to read SSH key: ${this.sshConfig.privateKeyPath}`));
          return;
        }
      } else if (this.sshConfig.password) {
        connectConfig.password = this.sshConfig.password;
      }

      this.client!.on('ready', () => {
        this.client!.shell(
          {
            term: 'xterm-256color',
            cols: options.cols,
            rows: options.rows,
          } as Record<string, unknown>,
          (err: Error | undefined, stream: NodeJS.ReadWriteStream) => {
            if (err) {
              reject(err);
              return;
            }

            this.stream = stream;
            this._connected = true;

            // Build the command: inject env vars via `env` (avoids shell history)
            // then cd to the working directory and launch the CLI tool
            const binary = options.binaryName || 'claude';
            const envParts = Object.entries(options.env)
              .filter(([, v]) => v)
              .map(([k, v]) => `${k}=${v.replace(/'/g, "'\\''")}`);

            const cliArgs = options.cliArgs?.join(' ') || '';
            // Single-quote wrap + escape embedded quotes so multi-word prompts
            // and shell metachars reach the CLI as one positional arg.
            const promptArg = options.initialPrompt
              ? ` '${options.initialPrompt.replace(/'/g, "'\\''")}'`
              : '';
            const cliCmd = (cliArgs ? `${binary} ${cliArgs}` : binary) + promptArg;

            let cmd: string;
            if (envParts.length > 0) {
              cmd = `cd ${options.workingDir} && env ${envParts.join(' ')} ${cliCmd}\n`;
            } else {
              cmd = `cd ${options.workingDir} && ${cliCmd}\n`;
            }

            // Wire up data flow. Use StringDecoder so multi-byte UTF-8 glyphs
            // (TUI box-drawing, spinners, emoji) that straddle SSH packet
            // boundaries don't decode to U+FFFD and corrupt cursor math.
            const decoder = new StringDecoder('utf8');
            stream.on('data', (data: Buffer) => {
              const str = decoder.write(data);
              if (!str) return;
              for (const cb of this.dataCallbacks) {
                cb(str);
              }
            });

            stream.on('close', () => {
              this._connected = false;
              this.stream = null;
              const info: TransportExitInfo = { exitCode: 0 };
              for (const cb of this.exitCallbacks) {
                cb(info);
              }
            });

            const setup = new SshSessionSetup({
              stream,
              cmd,
              useSudo: this.sshConfig.useSudo === true,
              password: this.sshConfig.password,
              host: this.sshConfig.host,
              resolve,
              reject,
            });
            stream.on('data', (data: Buffer) => setup.handleData(data));
          },
        );
      });

      this.client!.on('error', (err: Error) => {
        // If we already captured a clearer reason in the host verifier,
        // surface that to the user instead of the generic ssh2 error.
        const message = this.verifyError || err.message;
        log.error('SSH connection error', { host: this.sshConfig.host, error: message });
        this._connected = false;
        if (this.stream) {
          const info: TransportExitInfo = { exitCode: 1, signal: message };
          for (const cb of this.exitCallbacks) {
            cb(info);
          }
        } else {
          reject(new Error(message));
        }
      });

      this.client!.on('close', () => {
        if (this._connected) {
          this._connected = false;
          const info: TransportExitInfo = { exitCode: 1, signal: 'SSH connection closed' };
          for (const cb of this.exitCallbacks) {
            cb(info);
          }
        }
      });

      this.client!.connect(connectConfig as Parameters<InstanceType<typeof import('ssh2').Client>['connect']>[0]);
    });
  }

  write(data: string): void {
    this.stream?.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.stream && 'setWindow' in this.stream) {
      (this.stream as { setWindow(rows: number, cols: number, height: number, width: number): void })
        .setWindow(rows, cols, 0, 0);
    }
  }

  async stop(): Promise<void> {
    // Send Ctrl+C then exit
    this.stream?.write('\x03');
    await new Promise(r => setTimeout(r, 500));
    this.stream?.write('exit\n');
    await new Promise(r => setTimeout(r, 1000));
    this.client?.end();
  }

  kill(): void {
    this.client?.destroy();
    this._connected = false;
    this.stream = null;
    this.client = null;
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
