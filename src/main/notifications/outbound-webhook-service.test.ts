import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_NOTIFICATION_PREFS, type NotificationPrefs, type SessionState } from '../../shared/types';
import { OutboundWebhookService, parseWebhookUrl } from './outbound-webhook-service';

const envState = vi.hoisted(() => ({
  rows: new Map<string, { id: string; name: string }>(),
}));

vi.mock('../db/environment-repo', () => ({
  getEnvironment: (id: string) => envState.rows.get(id) ?? null,
}));

vi.mock('../session/session-manager', () => ({
  sessionManager: {
    addLifecycleObserver: vi.fn(() => vi.fn()),
  },
}));

function prefs(overrides: Partial<NotificationPrefs['webhook']> = {}): NotificationPrefs {
  return {
    ...DEFAULT_NOTIFICATION_PREFS,
    webhook: {
      ...DEFAULT_NOTIFICATION_PREFS.webhook,
      url: 'https://example.test/tether?token=secret',
      ...overrides,
    },
  };
}

function session(overrides: Partial<{
  id: string;
  label: string;
  workingDir: string;
  state: SessionState;
  cliTool: 'claude' | 'codex';
  environmentId: string | null;
  waitingReason: 'idle' | 'permission';
  notificationsMuted: boolean;
}> = {}) {
  return {
    id: 'sess-1',
    label: 'Feature work',
    workingDir: 'C:\\repo\\tether',
    state: 'waiting' as SessionState,
    cliTool: 'codex' as const,
    environmentId: 'env-1',
    waitingReason: 'permission' as const,
    notificationsMuted: false,
    ...overrides,
  };
}

describe('parseWebhookUrl', () => {
  it('accepts only http and https URLs after trimming', () => {
    expect(parseWebhookUrl(' https://example.test/hook ')?.toString()).toBe('https://example.test/hook');
    expect(parseWebhookUrl('http://example.test/hook')?.protocol).toBe('http:');
    expect(parseWebhookUrl('')).toBeNull();
    expect(parseWebhookUrl('not a url')).toBeNull();
    expect(parseWebhookUrl('file:///tmp/hook')).toBeNull();
  });
});

describe('OutboundWebhookService', () => {
  it('posts a small stable payload for enabled events', async () => {
    envState.rows.set('env-1', { id: 'env-1', name: 'Dev VM' });
    const fetchImpl = vi.fn(async () => ({ ok: true } as Response));
    const service = new OutboundWebhookService({
      getPrefs: () => prefs(),
      fetchImpl,
      now: () => new Date('2026-07-05T12:00:00.000Z'),
    });

    await expect(service.fire('waiting', session())).resolves.toBe(true);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith('https://example.test/tether?token=secret', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }));
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body as string);
    expect(body).toEqual({
      event: 'waiting',
      timestamp: '2026-07-05T12:00:00.000Z',
      session: {
        id: 'sess-1',
        label: 'Feature work',
        workingDir: 'C:\\repo\\tether',
        state: 'waiting',
        cliTool: 'codex',
        environmentId: 'env-1',
        environmentName: 'Dev VM',
        waitingReason: 'permission',
      },
    });
    expect(JSON.stringify(body)).not.toContain('secret=');
  });

  it('gates posts by per-event prefs', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true } as Response));
    const service = new OutboundWebhookService({
      getPrefs: () => prefs({ onWaiting: false, onIdle: true }),
      fetchImpl,
    });

    await service.fire('waiting', session());
    await service.fire('idle', session({ state: 'idle', waitingReason: undefined }));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('suppresses posts for muted sessions', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true } as Response));
    const service = new OutboundWebhookService({ getPrefs: () => prefs(), fetchImpl });

    await expect(service.fire('waiting', session({ notificationsMuted: true }))).resolves.toBe(false);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('no-ops for blank, invalid, and unsupported URLs', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true } as Response));
    for (const url of ['', 'not a url', 'file:///tmp/hook']) {
      const service = new OutboundWebhookService({ getPrefs: () => prefs({ url }), fetchImpl });
      await expect(service.fire('waiting', session())).resolves.toBe(false);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('swallows POST failures without throwing', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('network down'); });
    const service = new OutboundWebhookService({ getPrefs: () => prefs(), fetchImpl });

    await expect(service.fire('waiting', session())).resolves.toBe(false);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('maps dead state changes and bell events through their enabled flags', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true } as Response));
    const service = new OutboundWebhookService({
      getPrefs: () => prefs({ onDead: true, onBell: true }),
      fetchImpl,
    });

    service.handleStateChanged(session({ state: 'stopped' }));
    service.handleStateChanged(session({ state: 'dead', waitingReason: undefined }));
    service.handleBell(session({ state: 'running', waitingReason: undefined }));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const events = fetchImpl.mock.calls.map(call => JSON.parse(call[1].body as string).event);
    expect(events).toEqual(['dead', 'bell']);
  });
});
