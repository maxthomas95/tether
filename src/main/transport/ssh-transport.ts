import type { SessionTransport, TransportStartOptions, TransportExitInfo } from './types';

let ssh2Module: typeof import('ssh2') | null = null;

function getSsh2(): typeof import('ssh2') {
  if (!ssh2Module) {
    ssh2Module = require('ssh2');
  }
  return ssh2Module;
}

export interface SSHConfig {
  host: string;
  port: number;
  username: string;
  privateKeyPath?: string;
  useAgent?: boolean;
}

export class SSHTransport implements SessionTransport {
  private client: InstanceType<typeof import('ssh2').Client> | null = null;
  private stream: NodeJS.ReadWriteStream | null = null;
  private dataCallbacks: Array<(data: string) => void> = [];
  private exitCallbacks: Array<(info: TransportExitInfo) => void> = [];
  private _connected = false;
  private sshConfig: SSHConfig;

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

    return new Promise<void>((resolve, reject) => {
      const connectConfig: Record<string, unknown> = {
        host: this.sshConfig.host,
        port: this.sshConfig.port || 22,
        username: this.sshConfig.username,
        keepaliveInterval: 10000,
        keepaliveCountMax: 3,
        readyTimeout: 15000,
      };

      // Authentication: agent or private key
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
            // then cd to the working directory and launch claude
            const envParts = Object.entries(options.env)
              .filter(([, v]) => v)
              .map(([k, v]) => `${k}=${v.replace(/'/g, "'\\''")}`);

            const cliArgs = options.cliArgs?.join(' ') || '';
            const claudeCmd = cliArgs ? `claude ${cliArgs}` : 'claude';

            let cmd: string;
            if (envParts.length > 0) {
              cmd = `cd ${options.workingDir} && env ${envParts.join(' ')} ${claudeCmd}\n`;
            } else {
              cmd = `cd ${options.workingDir} && ${claudeCmd}\n`;
            }

            // Wire up data flow
            stream.on('data', (data: Buffer) => {
              const str = data.toString('utf-8');
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

            // Send the command to start claude
            stream.write(cmd);

            resolve();
          },
        );
      });

      this.client!.on('error', (err: Error) => {
        this._connected = false;
        if (this.stream) {
          const info: TransportExitInfo = { exitCode: 1, signal: err.message };
          for (const cb of this.exitCallbacks) {
            cb(info);
          }
        } else {
          reject(err);
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
