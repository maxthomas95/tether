import type { Duplex } from 'node:stream';

/**
 * Narrow seam between the RemoteHookAgent and whatever carries its control
 * channel to the host. PR 2 ships the ssh2-backed implementation
 * (`ssh-control-connection.ts`); PR 3 plugs in a Coder variant built from
 * ssh2-over-`coder ssh --stdio`. Tests fake the whole interface, so the
 * agent's lifecycle logic (probe → scrub → upload → forward → install) is
 * exercised without a network.
 */

export interface RemoteExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** SFTP-shaped file operations against the remote filesystem. */
export interface RemoteFileOps {
  /** Resolve a remote path (`'.'` → the login user's home directory). */
  realpath(p: string): Promise<string>;
  /** UTF-8 file content, or `null` when the file does not exist. */
  readFile(p: string): Promise<string | null>;
  writeFile(p: string, data: string, mode?: number): Promise<void>;
  /** Rename with overwrite (POSIX semantics where the server supports them). */
  rename(from: string, to: string): Promise<void>;
  /** Best-effort delete; resolves even when the file is already gone. */
  unlink(p: string): Promise<void>;
  chmod(p: string, mode: number): Promise<void>;
}

export interface ControlConnection {
  /** Run a command on the host, collecting exit code and output. */
  exec(cmd: string): Promise<RemoteExecResult>;
  /** File operations (SFTP subsystem). Cached per connection. */
  files(): Promise<RemoteFileOps>;
  /**
   * Reverse-forward a Unix domain socket on the host. Every connection a
   * remote process makes to `socketPath` arrives locally as a duplex stream
   * passed to `onStream`.
   */
  forwardUnix(socketPath: string, onStream: (stream: Duplex) => void): Promise<void>;
  /**
   * Fallback for hosts where sshd forbids streamlocal forwarding: reverse-
   * forward a server-assigned loopback TCP port. Returns the bound port.
   */
  forwardTcp(onStream: (stream: Duplex) => void): Promise<number>;
  /** Register a handler for the connection dropping (network, sshd restart…). */
  onClose(cb: () => void): void;
  /** Tear the connection down. Idempotent. */
  end(): void;
}

export type ControlConnectionFactory = () => Promise<ControlConnection>;
