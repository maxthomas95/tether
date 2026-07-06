import type { Duplex } from 'node:stream';
import type { SFTPWrapper } from 'ssh2';
import { loadSsh2 } from '../../transport/ssh2-loader';
import { buildSshConnectConfig } from '../../transport/ssh-connect-config';
import type { SSHConfig } from '../../transport/ssh-transport';
import { createLogger } from '../../logger';
import type { ControlConnection, RemoteExecResult, RemoteFileOps } from './control-connection';

const log = createLogger('ssh-control');

type SshClient = InstanceType<typeof import('ssh2').Client>;

/**
 * ssh2-backed control connection for the remote hook agent: a second,
 * dedicated `Client` on the same host config as the PTY transport (same
 * host-key verification, same auth cascade via `buildSshConnectConfig`).
 * The PTY transport itself is never touched — dumb pipe preserved.
 */

/** SFTP status code 2 — SSH_FX_NO_SUCH_FILE. */
const SFTP_NO_SUCH_FILE = 2;

function isNoSuchFile(err: unknown): boolean {
  return (err as { code?: number })?.code === SFTP_NO_SUCH_FILE;
}

function wrapSftp(sftp: SFTPWrapper): RemoteFileOps {
  // OpenSSH's plain SFTP rename refuses to overwrite; the
  // posix-rename@openssh.com extension (exposed by ssh2 as
  // `ext_openssh_rename`) has overwrite semantics. Fall back to
  // unlink-then-rename for servers without the extension — a narrow
  // non-atomic window we accept only on those servers.
  const extRename = (sftp as unknown as {
    ext_openssh_rename?: (from: string, to: string, cb: (err?: Error) => void) => void;
  }).ext_openssh_rename;

  const plainRename = (from: string, to: string) =>
    new Promise<void>((resolve, reject) => {
      sftp.rename(from, to, (err) => (err ? reject(err) : resolve()));
    });

  return {
    realpath: (p) =>
      new Promise((resolve, reject) => {
        sftp.realpath(p, (err, abs) => (err ? reject(err) : resolve(abs)));
      }),
    readFile: (p) =>
      new Promise((resolve, reject) => {
        sftp.readFile(p, (err, buf) => {
          if (err) {
            if (isNoSuchFile(err)) resolve(null);
            else reject(err);
            return;
          }
          resolve(buf.toString('utf8'));
        });
      }),
    writeFile: (p, data, mode) =>
      new Promise((resolve, reject) => {
        const options = mode !== undefined ? { mode } : {};
        sftp.writeFile(p, Buffer.from(data, 'utf8'), options, (err) => (err ? reject(err) : resolve()));
      }),
    rename: async (from, to) => {
      if (extRename) {
        await new Promise<void>((resolve, reject) => {
          extRename.call(sftp, from, to, (err?: Error) => (err ? reject(err) : resolve()));
        });
        return;
      }
      await new Promise<void>((resolve) => sftp.unlink(to, () => resolve()));
      await plainRename(from, to);
    },
    unlink: (p) =>
      new Promise((resolve) => {
        sftp.unlink(p, () => resolve());
      }),
    chmod: (p, mode) =>
      new Promise((resolve, reject) => {
        sftp.chmod(p, mode, (err) => (err ? reject(err) : resolve()));
      }),
  };
}

export async function connectSshControl(sshConfig: SSHConfig): Promise<ControlConnection> {
  const { Client } = loadSsh2();
  const client: SshClient = new Client();
  let verifyError: string | null = null;

  await new Promise<void>((resolve, reject) => {
    let connectConfig: Record<string, unknown>;
    try {
      connectConfig = buildSshConnectConfig(sshConfig, (reason) => {
        verifyError = reason;
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    client.once('ready', () => resolve());
    client.once('error', (err: Error) => reject(new Error(verifyError || err.message)));
    client.connect(connectConfig as Parameters<SshClient['connect']>[0]);
  });

  log.info('Control connection ready', { host: sshConfig.host });

  const closeCallbacks: Array<() => void> = [];
  let ended = false;
  client.on('close', () => {
    for (const cb of closeCallbacks) {
      try { cb(); } catch { /* close observers never throw upward */ }
    }
  });
  // Post-connect errors surface via 'close'; without a listener ssh2 would
  // throw them as uncaught exceptions.
  client.on('error', (err: Error) => {
    log.warn('Control connection error', { host: sshConfig.host, error: err.message });
  });

  let filesPromise: Promise<RemoteFileOps> | null = null;

  // ssh2 delivers every accepted reverse-forward stream through connection-
  // level events; route by socket path so multiple forwards could coexist.
  const unixHandlers = new Map<string, (stream: Duplex) => void>();
  let tcpHandler: ((stream: Duplex) => void) | null = null;

  type ForwardAccept = () => Duplex;
  type ForwardReject = () => void;
  const evClient = client as unknown as {
    on(event: 'unix connection', cb: (info: { socketPath: string }, accept: ForwardAccept, reject: ForwardReject) => void): void;
    on(event: 'tcp connection', cb: (info: unknown, accept: ForwardAccept, reject: ForwardReject) => void): void;
    openssh_forwardInStreamLocal(socketPath: string, cb: (err?: Error) => void): void;
  };

  evClient.on('unix connection', (info, accept, reject) => {
    const handler = unixHandlers.get(info.socketPath);
    if (!handler) {
      reject();
      return;
    }
    handler(accept());
  });

  evClient.on('tcp connection', (_info, accept, reject) => {
    if (!tcpHandler) {
      reject();
      return;
    }
    tcpHandler(accept());
  });

  return {
    exec: (cmd) =>
      new Promise<RemoteExecResult>((resolve, reject) => {
        client.exec(cmd, (err, stream) => {
          if (err) {
            reject(err);
            return;
          }
          let stdout = '';
          let stderr = '';
          stream.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
          stream.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
          stream.on('close', (code: number | null) => resolve({ code, stdout, stderr }));
          stream.on('error', (streamErr: Error) => reject(streamErr));
        });
      }),

    files: () => {
      filesPromise ??= new Promise<RemoteFileOps>((resolve, reject) => {
        client.sftp((err, sftp) => (err ? reject(err) : resolve(wrapSftp(sftp))));
      });
      return filesPromise;
    },

    forwardUnix: (socketPath, onStream) =>
      new Promise<void>((resolve, reject) => {
        unixHandlers.set(socketPath, onStream);
        evClient.openssh_forwardInStreamLocal(socketPath, (err?: Error) => {
          if (err) {
            unixHandlers.delete(socketPath);
            reject(err);
            return;
          }
          resolve();
        });
      }),

    forwardTcp: (onStream) =>
      new Promise<number>((resolve, reject) => {
        tcpHandler = onStream;
        client.forwardIn('127.0.0.1', 0, (err, port) => {
          if (err) {
            tcpHandler = null;
            reject(err);
            return;
          }
          resolve(port);
        });
      }),

    onClose: (cb) => {
      closeCallbacks.push(cb);
    },

    end: () => {
      if (ended) return;
      ended = true;
      try { client.end(); } catch { /* already down */ }
    },
  };
}
