import { RemoteProbeRequestError, connectRemoteUsage, type RemoteUsageConnection } from './remote-command';
import { RemoteAuthError, isRemoteAuthFailed } from './remote-auth-state';
import type { RemoteProbeTarget, RemoteSubagentReply, RemoteSubagentRequest } from './remote-protocol';
import { createLogger } from '../logger';

const log = createLogger('remote-probe-channels');

/** Wait before trying a host again after its reader could not be started or kept failing. */
export const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000] as const;
/**
 * Requests in a row that got no reply at all before the reader counts as
 * unresponsive. An error reply or a successful one proves it is alive and
 * resets the count, so one session's always-failing request cannot churn a
 * reader that other sessions are using.
 */
const MAX_CONSECUTIVE_TIMEOUTS = 3;
/** A reader must stay up this long before its host's backoff is forgiven. */
export const HEALTHY_MS = 10 * 60_000;
/**
 * Sessions hold the reader while they are alive, however idle. Once the last one
 * lets go it is kept this long, so a restarted session does not log in again.
 */
const IDLE_CLOSE_MS = 60_000;

type Connect = (environmentId: string, workspace: string, signal?: AbortSignal, options?: { resident?: boolean }) => Promise<RemoteUsageConnection>;

/** Survives the host entry (and its reader) being dropped, so idle gaps do not reset the backoff. */
interface HostHealth {
  /** Replacements and failed starts since the reader last stayed healthy; picks the backoff step. */
  retryCount: number;
  retryAt: number;
}

interface Host {
  key: string;
  target: RemoteProbeTarget;
  leases: number;
  health: HostHealth;
  connection?: RemoteUsageConnection;
  connecting?: Promise<RemoteUsageConnection>;
  connectedAt: number;
  timeouts: number;
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
  private readonly health = new Map<string, HostHealth>();

  constructor(
    private readonly connect: Connect = connectRemoteUsage,
    private readonly now: () => number = Date.now,
  ) {}

  acquire(target: RemoteProbeTarget): RemoteProbeLease {
    const key = JSON.stringify([target.environmentId, target.workspace]);
    let host = this.hosts.get(key);
    if (!host) {
      let health = this.health.get(key);
      if (!health) { health = { retryCount: 0, retryAt: 0 }; this.health.set(key, health); }
      host = { key, target, leases: 0, health, connectedAt: 0, timeouts: 0, abort: new AbortController() };
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
    if (isRemoteAuthFailed(host.target.environmentId)) throw new RemoteAuthError();
    const connection = await this.open(host);
    try {
      const reply = await connection.poll(request);
      host.timeouts = 0;
      if (this.now() - host.connectedAt >= HEALTHY_MS) host.health.retryCount = 0;
      return reply;
    } catch (error) {
      // Only a reader that is gone, or that has answered nothing at all for
      // several requests, is replaced (a new login, so behind the backoff).
      // An error reply or one slow request leaves it alone.
      const kind = error instanceof RemoteProbeRequestError ? error.kind : undefined;
      if (kind === 'timeout') {
        if (++host.timeouts >= MAX_CONSECUTIVE_TIMEOUTS) this.fail(host, connection);
      } else {
        host.timeouts = 0;
        if (kind === 'dead' || connection.isDead?.()) this.fail(host, connection);
      }
      throw error;
    }
  }

  private async open(host: Host): Promise<RemoteUsageConnection> {
    if (host.connection) return host.connection;
    if (this.now() < host.health.retryAt) throw new Error('Remote usage reader unavailable');
    host.connecting ??= this.connect(host.target.environmentId, host.target.workspace, host.abort.signal, { resident: true })
      .then(connection => {
        if (this.hosts.get(host.key) !== host) { connection.close(); throw new Error('Remote usage reader unavailable'); }
        host.connection = connection;
        host.connectedAt = this.now();
        host.timeouts = 0;
        return connection;
      })
      .catch(error => {
        // Never log the error text: it can carry remote shell output.
        log.debug('Remote reader did not start', { environmentId: host.target.environmentId });
        // A refused password is not retried at all (see remote-auth-state), so
        // it needs no timer.
        if (!(error instanceof RemoteAuthError)) this.backoff(host);
        throw error;
      })
      .finally(() => { host.connecting = undefined; });
    return host.connecting;
  }

  private fail(host: Host, connection: RemoteUsageConnection): void {
    // A reader that ran long enough before dying starts a fresh backoff.
    if (this.now() - host.connectedAt >= HEALTHY_MS) host.health.retryCount = 0;
    if (host.connection === connection) host.connection = undefined;
    connection.close();
    this.backoff(host);
  }

  private backoff(host: Host): void {
    host.timeouts = 0;
    host.health.retryAt = this.now() + BACKOFF_MS[Math.min(host.health.retryCount, BACKOFF_MS.length - 1)];
    host.health.retryCount++;
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
