import { getEnvironment } from '../db/environment-repo';
import { createLogger } from '../logger';
import { sessionManager, type Session, type SessionLifecycleObserver } from '../session/session-manager';
import type { CliToolId, NotificationPrefs, SessionState, WaitingReason } from '../../shared/types';

const log = createLogger('outbound-webhook');
const POST_TIMEOUT_MS = 3_000;

export type OutboundWebhookEvent = 'waiting' | 'idle' | 'dead' | 'bell';

export interface OutboundWebhookPayload {
  event: OutboundWebhookEvent;
  timestamp: string;
  session: {
    id: string;
    label: string;
    workingDir: string;
    state: SessionState;
    cliTool: CliToolId;
    environmentId?: string;
    environmentName?: string;
    waitingReason?: WaitingReason;
  };
}

type FetchLike = typeof fetch;

interface OutboundWebhookServiceOptions {
  getPrefs: () => NotificationPrefs;
  fetchImpl?: FetchLike;
  now?: () => Date;
}

const EVENT_TO_PREF: Record<OutboundWebhookEvent, keyof NotificationPrefs['webhook']> = {
  waiting: 'onWaiting',
  idle: 'onIdle',
  dead: 'onDead',
  bell: 'onBell',
};

/**
 * Passive generic outbound webhook for session state changes. It deliberately
 * sends only session metadata, never PTY output, CLI args, env vars, or tokens.
 */
export class OutboundWebhookService {
  private readonly getPrefs: () => NotificationPrefs;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private unsubscribe: (() => void) | null = null;

  constructor(opts: OutboundWebhookServiceOptions) {
    this.getPrefs = opts.getPrefs;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => new Date());
  }

  start(): void {
    if (this.unsubscribe) return;
    const observer: SessionLifecycleObserver = {
      onStateChanged: (session) => this.handleStateChanged(session),
      onBell: (session) => this.handleBell(session),
    };
    this.unsubscribe = sessionManager.addLifecycleObserver(observer);
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  handleStateChanged(session: Session): void {
    if (session.state !== 'waiting' && session.state !== 'idle' && session.state !== 'dead') return;
    void this.fire(session.state, session);
  }

  handleBell(session: Session): void {
    void this.fire('bell', session);
  }

  async fire(event: OutboundWebhookEvent, session: Pick<Session, 'id' | 'label' | 'workingDir' | 'state' | 'cliTool' | 'environmentId' | 'waitingReason' | 'notificationsMuted'>): Promise<boolean> {
    try {
      const prefs = this.getPrefs();
      const url = parseWebhookUrl(prefs.webhook.url);
      if (!url) return false;
      if (!prefs.webhook[EVENT_TO_PREF[event]]) return false;
      if (session.notificationsMuted) return false;

      const payload = this.buildPayload(event, session);
      const res = await this.fetchImpl(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      if (!res.ok) {
        log.warn('Outbound webhook post returned non-success status', {
          event,
          sessionId: session.id,
          status: res.status,
        });
      }
      return res.ok;
    } catch (err) {
      log.warn('Outbound webhook post failed', {
        event,
        sessionId: session.id,
        errorName: err instanceof Error ? err.name : typeof err,
      });
      return false;
    }
  }

  buildPayload(
    event: OutboundWebhookEvent,
    session: Pick<Session, 'id' | 'label' | 'workingDir' | 'state' | 'cliTool' | 'environmentId' | 'waitingReason'>,
  ): OutboundWebhookPayload {
    const env = session.environmentId ? getEnvironment(session.environmentId) : null;
    return {
      event,
      timestamp: this.now().toISOString(),
      session: {
        id: session.id,
        label: session.label,
        workingDir: session.workingDir,
        state: session.state,
        cliTool: session.cliTool,
        ...(session.environmentId ? { environmentId: session.environmentId } : {}),
        ...(env?.name ? { environmentName: env.name } : {}),
        ...(session.waitingReason ? { waitingReason: session.waitingReason } : {}),
      },
    };
  }
}

export function parseWebhookUrl(raw: string): URL | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
}

export function createOutboundWebhookService(opts: { getPrefs: () => NotificationPrefs }): OutboundWebhookService {
  return new OutboundWebhookService(opts);
}
