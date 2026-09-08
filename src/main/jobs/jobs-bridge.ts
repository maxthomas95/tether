import { sessionManager, type Session } from '../session/session-manager';
import { getEnvironment } from '../db/environment-repo';
import { jobsService } from './jobs-service';
import { readJobsConfig } from './jobs-config';
import type { JobsSettings, SessionState } from '../../shared/types';

const POST_TIMEOUT_MS = 3_000;
const HEARTBEAT_MS = 60_000;
type Target = {
  url: string;
  token: string;
  started: Set<string>;
  /** Include in-flight starts so disconnect can remove them after they settle. */
  owned: Set<string>;
};
type PostResult = 'ok' | 'not-found' | 'failed';

/** Passive metadata only. Per-session queues keep start/status/stop in order. */
export class JobsBridge {
  private target: Target | null = null;
  private queues = new Map<string, Promise<void>>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribers: Array<() => void> = [];

  start(): void {
    if (this.heartbeatTimer) return;
    this.unsubscribers.push(
      sessionManager.addLifecycleObserver({
        onCreated: session => this.sync(session.id),
        onStateChanged: session => this.sync(session.id),
        onRemoved: id => this.sync(id),
      }),
      jobsService.onStatusChange(() => this.reconcile()),
    );
    this.reconcile();
    this.heartbeatTimer = setInterval(() => this.syncAll(), HEARTBEAT_MS);
  }

  private reconcile(): void {
    const status = jobsService.getStatus();
    if (status.enabled === 'off' || !status.detected) { this.detach(); return; }
    let cfg: JobsSettings;
    try { cfg = readJobsConfig(); } catch { this.detach(); return; }
    if (cfg.enabled === 'off' || !cfg.shareRemoteSessions) { this.detach(); return; }
    if (this.target?.url === status.url && this.target.token === cfg.token) return;
    this.detach();
    this.target = { url: status.url, token: cfg.token, started: new Set(), owned: new Set() };
    this.syncAll();
  }

  private detach(): void {
    const target = this.target;
    this.target = null;
    if (!target) return;
    for (const id of target.owned) {
      // Cleanup uses the old endpoint/token, including when settings were removed.
      this.enqueue(id, async () => { await this.post(target, id, { event: 'stop' }); });
    }
  }

  private isBridgeable(session: Session): boolean {
    if (!session.environmentId || !mapState(session.state)) return false;
    const env = getEnvironment(session.environmentId);
    return env?.type === 'ssh' || env?.type === 'coder';
  }

  private syncAll(): void {
    if (!this.target) return;
    const ids = new Set([...this.target.owned, ...sessionManager.listSessions().map(session => session.id)]);
    for (const id of ids) this.sync(id, true);
  }

  private enqueue(id: string, action: () => Promise<void>): void {
    const next = (this.queues.get(id) ?? Promise.resolve()).then(action).catch(() => {
      // Integration failures must never escape into session lifecycle handling.
    });
    this.queues.set(id, next);
    void next.then(() => { if (this.queues.get(id) === next) this.queues.delete(id); });
  }

  private sync(id: string, heartbeat = false): void {
    const target = this.target;
    if (!target) return;
    this.enqueue(id, async () => {
      if (this.target !== target) return;
      // Read current state after earlier posts settle, not the observer's stale snapshot.
      const session = sessionManager.getSession(id);
      if (!session || !this.isBridgeable(session)) {
        if (target.owned.has(id)) {
          const result = await this.post(target, id, { event: 'stop' });
          if (result !== 'failed') { target.owned.delete(id); target.started.delete(id); }
        }
        return;
      }
      if (!target.started.has(id)) { await this.sendStart(target, session); return; }
      const body = heartbeat ? { event: 'heartbeat' } : {
        event: 'status', state: mapState(session.state), activity: activityFor(session),
      };
      const result = await this.post(target, id, body);
      if (result === 'not-found' && this.target === target) {
        target.started.delete(id);
        const current = sessionManager.getSession(id);
        if (current && this.isBridgeable(current)) await this.sendStart(target, current);
      }
    });
  }

  private async sendStart(target: Target, session: Session): Promise<void> {
    if (this.target !== target) return;
    target.owned.add(session.id);
    const result = await this.post(target, session.id, {
      event: 'start', source_name: session.label, source_type: 'tether',
      project: session.workingDir.split(/[\\/]/).filter(Boolean).pop() || '',
      machine: session.environmentId ? getEnvironment(session.environmentId)?.name : undefined,
      state: mapState(session.state), activity: activityFor(session),
    });
    if (result === 'ok' && this.target === target) target.started.add(session.id);
  }

  private async post(target: Target, sessionId: string, body: Record<string, unknown>): Promise<PostResult> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (target.token) headers.Authorization = `Bearer ${target.token}`;
    try {
      const res = await fetch(`${target.url}/api/webhooks`, {
        method: 'POST', headers, redirect: 'error',
        body: JSON.stringify({ ...body, source_id: `tether-${sessionId}` }),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      if (this.target === target) {
        let error: string | undefined;
        if (res.status === 401 || res.status === 403) error = 'JOBS rejected session sharing. Check the webhook token and save again.';
        else if (res.status === 404 && body.event === 'start') error = 'JOBS session sharing endpoint was not found. Check the server URL and JOBS version.';
        else if (!res.ok && res.status !== 404) error = `JOBS session sharing returned HTTP ${res.status}.`;
        jobsService.setBridgeError(error);
      }
      if (res.status === 404) return 'not-found';
      return res.ok ? 'ok' : 'failed';
    } catch {
      if (this.target === target) jobsService.setBridgeError('Session sharing could not reach JOBS. Tether will retry automatically.');
      return 'failed';
    }
  }

  dispose(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
    this.detach();
  }
}

function mapState(state: SessionState): string | null {
  switch (state) {
    case 'starting': case 'running': return 'running';
    case 'waiting': return 'waiting';
    case 'idle': return 'idle';
    default: return null;
  }
}

function activityFor(session: Session): string | undefined {
  if (session.state === 'waiting') return session.waitingReason === 'permission' ? 'Awaiting permission' : 'Waiting for input';
  if (session.state === 'running') return `Running ${session.cliTool}`;
  return undefined;
}

export const jobsBridge = new JobsBridge();
