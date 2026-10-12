import { connectRemoteUsage, type RemoteUsageConnection } from './remote-command';
import type { RemoteProbeTarget, RemoteSubagentReply, RemoteSubagentRequest } from './remote-protocol';
import { createLogger } from '../logger';

const log = createLogger('remote-probe-channels');

/** Wait before trying a host again after its reader could not be started or kept failing. */
export const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000] as const;
/** Requests that fail on a live reader before it is replaced. */
const MAX_CONSECUTIVE_FAILURES = 3;
/**
 * Sessions hold the reader while they are alive, however idle. Once the last one
 * lets go it is kept this long, so a restarted session does not log in again.
 */
const IDLE_CLOSE_MS = 60_000;

type Connect = (environmentId: string, workspace: string, signal?: AbortSignal, options?: { resident?: boolean }) => Promise<RemoteUsageConnection>;

interface Host {
  key: string;
  target: RemoteProbeTarget;
  leases: number;
  connection?: RemoteUsageConnection;
  connecting?: Promise<RemoteUsageConnection>;
  failures: number;
  /** Failed starts in a row; picks the next backoff step. */
  retryCount: number;
  retryAt: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  abort: AbortController;
}

export interface RemoteProbeLease {
  call(request: RemoteSubagentRequest): Promise<RemoteSubagentReply>;
  release(): void;
}

/**
 * One resident reader per remote host (per Coder workspace), shared by every
 * session that asks for it. The reader is started lazily, once, and then only
 * ever receives requests; a host that cannot start one is left alone for a
 * growing interval instead of being retried on every poll, because a retry on
 * an elevated SSH host is a `sudo` and a logon event.
 */
export class RemoteProbeChannels {
  private readonly hosts = new Map<string, Host>();

  constructor(
    private readonly connect: Connect = connectRemoteUsage,
    private readonly now: () => number = Date.now,
  ) {}

  acquire(target: RemoteProbeTarget): RemoteProbeLease {
    const key = JSON.stringify([target.environmentId, target.workspace]);
    let host = this.hosts.get(key);
    if (!host) {
      host = { key, target, leases: 0, failures: 0, retryCount: 0, retryAt: 0, abort: new AbortController() };
      this.hosts.set(key, host);
    }
    if (host.idleTimer) { clearTimeout(host.idleTimer); host.idleTimer = undefined; }
    host.leases++;
    const held = host;
    let released = false;
    return {
      call: request => this.call(held, request),
      release: () => {
        if (released) return;
        released = true;
        this.release(held);
      },
    };
  }

  /** Readers currently open; for tests and diagnostics. */
  get openCount(): number {
    return [...this.hosts.values()].filter(h => h.connection).length;
  }

  dispose(): void {
    for (const host of [...this.hosts.values()]) this.drop(host);
  }

  private async call(host: Host, request: RemoteSubagentRequest): Promise<RemoteSubagentReply> {
    if (this.hosts.get(host.key) !== host) throw new Error('Remote usage reader unavailable');
    const connection = await this.open(host);
    try {
      const reply = await connection.poll(request);
      host.failures = 0;
      host.retryCount = 0;
      return reply;
    } catch (error) {
      // A reply that failed validation or timed out leaves the reader healthy
      // enough to try again; one that keeps failing is replaced, behind the
      // same backoff as a reader that never started.
      if (connection.isDead?.() || ++host.failures >= MAX_CONSECUTIVE_FAILURES) this.fail(host, connection);
      throw error;
    }
  }

  private async open(host: Host): Promise<RemoteUsageConnection> {
    if (host.connection) return host.connection;
    if (this.now() < host.retryAt) throw new Error('Remote usage reader unavailable');
    host.connecting ??= this.connect(host.target.environmentId, host.target.workspace, host.abort.signal, { resident: true })
      .then(connection => {
        if (this.hosts.get(host.key) !== host) { connection.close(); throw new Error('Remote usage reader unavailable'); }
        host.connection = connection;
        return connection;
      })
      .catch(error => {
        // Never log the error text: it can carry remote shell output.
        log.debug('Remote reader did not start', { environmentId: host.target.environmentId });
        this.backoff(host);
        throw error;
      })
      .finally(() => { host.connecting = undefined; });
    return host.connecting;
  }

  private fail(host: Host, connection: RemoteUsageConnection): void {
    if (host.connection === connection) host.connection = undefined;
    connection.close();
    this.backoff(host);
  }

  private backoff(host: Host): void {
    host.failures = 0;
    host.retryAt = this.now() + BACKOFF_MS[Math.min(host.retryCount, BACKOFF_MS.length - 1)];
    host.retryCount++;
  }

  private release(host: Host): void {
    host.leases = Math.max(0, host.leases - 1);
    if (host.leases > 0 || host.idleTimer) return;
    host.idleTimer = setTimeout(() => this.drop(host), IDLE_CLOSE_MS);
    host.idleTimer.unref?.();
  }

  private drop(host: Host): void {
    if (host.idleTimer) clearTimeout(host.idleTimer);
    host.abort.abort();
    host.connection?.close();
    host.connection = undefined;
    this.hosts.delete(host.key);
  }
}

export const remoteProbeChannels = new RemoteProbeChannels();
