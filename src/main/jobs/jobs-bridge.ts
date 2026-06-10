import { sessionManager, type Session } from '../session/session-manager';
import { getEnvironment } from '../db/environment-repo';
import { jobsService, readJobsConfig } from './jobs-service';
import { createLogger } from '../logger';
import type { SessionState } from '../../shared/types';

const log = createLogger('jobs-bridge');

const POST_TIMEOUT_MS = 3_000;
/** JOBS stale-evicts webhook agents after ~180s without events — beat that comfortably. */
const HEARTBEAT_MS = 60_000;

/**
 * Narrates Tether's SSH and Coder sessions into the J.O.B.S. office via its
 * webhook API. Local sessions are deliberately excluded: JOBS already sees
 * those through its own `~/.claude/projects` JSONL watcher, and bridging them
 * too would put two copies of the same agent in the office.
 *
 * Everything here is fire-and-forget — a missing or slow JOBS server must
 * never affect session handling, so all posts swallow errors.
 */
class JobsBridge {
  /** Session ids we've sent a `start` event for (and owe a `stop`). */
  private started = new Set<string>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribers: Array<() => void> = [];

  start(): void {
    this.unsubscribers.push(
      sessionManager.addLifecycleObserver({
        onCreated: (session) => this.handleCreated(session),
        onStateChanged: (session) => this.handleStateChanged(session),
        onRemoved: (sessionId) => this.handleRemoved(sessionId),
      }),
      jobsService.onStatusChange((status) => {
        if (status.detected) {
          // JOBS just came up (or came back) — introduce every live remote session.
          for (const session of sessionManager.listSessions()) {
            if (this.isBridgeable(session)) void this.sendStart(session);
          }
        } else {
          // Server gone — our agents will stale-evict over there; forget local state.
          this.started.clear();
        }
      }),
    );
    this.heartbeatTimer = setInterval(() => this.heartbeatTick(), HEARTBEAT_MS);
  }

  dispose(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
    this.started.clear();
  }

  /** Remote (SSH/Coder) sessions only — local ones reach JOBS via its JSONL watcher. */
  private isBridgeable(session: Session): boolean {
    if (!session.environmentId) return false;
    const env = getEnvironment(session.environmentId);
    return !!env && env.type !== 'local';
  }

  private machineFor(session: Session): string | undefined {
    if (!session.environmentId) return undefined;
    return getEnvironment(session.environmentId)?.name;
  }

  private handleCreated(session: Session): void {
    if (!jobsService.getStatus().detected || !this.isBridgeable(session)) return;
    void this.sendStart(session);
  }

  private handleStateChanged(session: Session): void {
    if (!jobsService.getStatus().detected || !this.isBridgeable(session)) return;

    if (session.state === 'stopped') {
      void this.send(session.id, { event: 'stop' });
      this.started.delete(session.id);
      return;
    }
    if (session.state === 'dead') {
      // Keep the agent visible in the office's error state; `stop` follows
      // when the user removes the session from the sidebar.
      void this.send(session.id, { event: 'error', activity: 'Session died' });
      return;
    }

    const state = mapState(session.state);
    if (!state) return;
    void this.send(session.id, {
      event: 'status',
      state,
      activity: activityFor(session),
    });
  }

  private handleRemoved(sessionId: string): void {
    if (!this.started.has(sessionId)) return;
    this.started.delete(sessionId);
    if (!jobsService.getStatus().detected) return;
    void this.send(sessionId, { event: 'stop' });
  }

  private heartbeatTick(): void {
    if (!jobsService.getStatus().detected) return;
    for (const id of this.started) {
      if (!sessionManager.getSession(id)) {
        this.started.delete(id);
        continue;
      }
      void this.send(id, { event: 'heartbeat' });
    }
  }

  private async sendStart(session: Session): Promise<void> {
    const body: Record<string, unknown> = {
      event: 'start',
      source_name: session.label,
      source_type: 'tether',
      project: session.workingDir.split(/[\\/]/).pop() || session.workingDir,
      machine: this.machineFor(session),
      state: mapState(session.state) ?? 'running',
      activity: activityFor(session),
    };
    const ok = await this.post(session.id, body);
    if (ok) this.started.add(session.id);
  }

  /** Post a non-start event; on 404 (JOBS restarted, agent unknown) re-introduce and retry once. */
  private async send(sessionId: string, body: Record<string, unknown>): Promise<void> {
    const res = await this.post(sessionId, body);
    if (res === 'not-found') {
      this.started.delete(sessionId);
      const session = sessionManager.getSession(sessionId);
      if (session && this.isBridgeable(session)) {
        await this.sendStart(session);
      }
    }
  }

  /** Returns true on 2xx, 'not-found' on 404, false otherwise. */
  private async post(sessionId: string, body: Record<string, unknown>): Promise<boolean | 'not-found'> {
    const cfg = readJobsConfig();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
    try {
      const res = await fetch(`${cfg.url}/api/webhooks`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...body, source_id: `tether-${sessionId}` }),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      if (res.status === 404) return 'not-found';
      return res.ok;
    } catch (err) {
      log.warn('JOBS webhook post failed', { error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }
}

/** Tether SessionState → JOBS webhook state. Stop/dead are events, not states. */
function mapState(state: SessionState): string | null {
  switch (state) {
    case 'starting':
    case 'running':
      return 'running';
    case 'waiting':
      return 'waiting';
    case 'idle':
      return 'idle';
    default:
      return null;
  }
}

function activityFor(session: Session): string | undefined {
  if (session.state === 'waiting') {
    return session.waitingReason === 'permission' ? 'Awaiting permission' : 'Waiting for input';
  }
  if (session.state === 'running') return `Running ${session.cliTool}`;
  return undefined;
}

export const jobsBridge = new JobsBridge();
