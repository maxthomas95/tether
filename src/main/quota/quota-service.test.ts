import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsMocks = vi.hoisted(() => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
}));

vi.mock('node:fs', () => fsMocks);
vi.mock('../logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
vi.mock('../codex/integration-service', () => ({ readCodexQuota: vi.fn() }));

import { readCodexQuota } from '../codex/integration-service';
import { normalizeCodexResetAt, parseScopedClaudeLimits, QuotaService } from './quota-service';

beforeEach(() => {
  fsMocks.readFileSync.mockReset().mockImplementation(() => { throw new Error('No local credentials'); });
  fsMocks.writeFileSync.mockReset();
  fsMocks.renameSync.mockReset();
  vi.mocked(readCodexQuota).mockReset().mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function claudeCredentials(accessToken: string, expiresAt: number): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken,
      refreshToken: 'must-not-be-read',
      expiresAt,
      subscriptionType: 'max',
      rateLimitTier: 'default',
    },
  });
}

function usageResponse(): Response {
  return new Response(JSON.stringify({
    five_hour: { utilization: 25, resets_at: '2026-11-10T01:00:00.000Z' },
    seven_day: { utilization: 50, resets_at: '2026-11-16T01:00:00.000Z' },
    limits: [
      { kind: 'session', group: 'session', percent: 25, resets_at: '2026-11-10T01:00:00.000Z', scope: null },
      { kind: 'weekly_all', group: 'weekly', percent: 50, resets_at: '2026-11-16T01:00:00.000Z', scope: null },
      {
        kind: 'weekly_scoped',
        group: 'weekly',
        percent: 26,
        resets_at: '2026-11-16T01:00:00.000Z',
        scope: { model: { id: null, display_name: 'Fable' }, surface: null },
      },
    ],
  }), { status: 200 });
}

it('continues background polling after a failed refresh and stops cleanly', async () => {
  vi.useFakeTimers();
  const service = new QuotaService();
  const refresh = vi.spyOn(service, 'fetchQuota').mockRejectedValue(new Error('refresh failed'));
  try {
    service.start();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    service.stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  } finally {
    service.stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});

describe('normalizeCodexResetAt', () => {
  it('converts Unix seconds to an ISO timestamp', () => {
    const seconds = 1_764_608_400;

    expect(normalizeCodexResetAt(seconds)).toBe(new Date(seconds * 1000).toISOString());
  });

  it('keeps millisecond epoch values as milliseconds', () => {
    const millis = 1_764_608_400_000;

    expect(normalizeCodexResetAt(millis)).toBe(new Date(millis).toISOString());
  });

  it('normalizes numeric strings and ISO strings', () => {
    const seconds = '1764608400';
    const iso = '2025-12-01T13:00:00.000Z';

    expect(normalizeCodexResetAt(seconds)).toBe(new Date(1_764_608_400 * 1000).toISOString());
    expect(normalizeCodexResetAt(iso)).toBe(iso);
  });

  it('returns null for missing or invalid values', () => {
    expect(normalizeCodexResetAt(null)).toBeNull();
    expect(normalizeCodexResetAt(undefined)).toBeNull();
    expect(normalizeCodexResetAt('')).toBeNull();
    expect(normalizeCodexResetAt('not a date')).toBeNull();
  });
});

describe('Claude quota polling', () => {
  it('pauses expired credentials without fetching and retains the previous observation', async () => {
    let credentials = claudeCredentials('valid-token', Date.now() + 60 * 60_000);
    fsMocks.readFileSync.mockImplementation(() => credentials);
    const fetchMock = vi.fn().mockResolvedValue(usageResponse());
    vi.stubGlobal('fetch', fetchMock);
    const service = new QuotaService();

    const first = await service.fetchQuota();
    credentials = claudeCredentials('expired-token', Date.now() - 1);
    const expired = await service.fetchQuota();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(expired.error).toContain('paused');
    expect(expired.fiveHour).toEqual(first.fiveHour);
    expect(expired.sevenDay).toEqual(first.sevenDay);
    expect(expired.lastUpdated).toBe(first.lastUpdated);
  });

  it('uses a valid token to request the Claude usage endpoint and maps its windows', async () => {
    fsMocks.readFileSync.mockReturnValue(claudeCredentials('valid-token', Date.now() + 60 * 60_000));
    const fetchMock = vi.fn().mockResolvedValue(usageResponse());
    vi.stubGlobal('fetch', fetchMock);

    const result = await new QuotaService().fetchQuota();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/api/oauth/usage',
      expect.any(Object),
    );
    expect(result.fiveHour.utilization).toBe(25);
    expect(result.sevenDay.utilization).toBe(50);
    expect(result.scoped).toEqual([
      { label: 'Fable', utilization: 26, resetsAt: '2026-11-16T01:00:00.000Z' },
    ]);
  });

  it('keeps the last scoped limits when a later request fails', async () => {
    fsMocks.readFileSync.mockReturnValue(claudeCredentials('valid-token', Date.now() + 60 * 60_000));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(usageResponse())
      .mockResolvedValueOnce(new Response(null, { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const service = new QuotaService();

    const first = await service.fetchQuota();
    const failed = await service.fetchQuota();

    expect(failed.error).toContain('500');
    expect(failed.scoped).toEqual(first.scoped);
  });

  it('never refreshes credentials or writes Claude Code sign-in data', async () => {
    const fetchMock = vi.fn().mockResolvedValue(usageResponse());
    vi.stubGlobal('fetch', fetchMock);

    fsMocks.readFileSync.mockReturnValue(claudeCredentials('expired-token', Date.now() - 1));
    await new QuotaService().fetchQuota();

    fsMocks.readFileSync.mockReturnValue(claudeCredentials('near-expiry-token', Date.now() + 1));
    await new QuotaService().fetchQuota();

    fsMocks.readFileSync.mockReturnValue(claudeCredentials('rejected-token', Date.now() + 60 * 60_000));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    await new QuotaService().fetchQuota();

    expect(fetchMock.mock.calls.every(([url]) => url === 'https://api.anthropic.com/api/oauth/usage')).toBe(true);
    expect(fsMocks.writeFileSync).not.toHaveBeenCalled();
    expect(fsMocks.renameSync).not.toHaveBeenCalled();
  });

  it('backs off rejected tokens and immediately retries when the saved token changes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-09T12:00:00.000Z'));
    let credentials = claudeCredentials('rejected-token', Date.now() + 60 * 60_000);
    fsMocks.readFileSync.mockImplementation(() => credentials);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const service = new QuotaService();

    await service.fetchQuota();
    await service.fetchQuota();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(300_001);
    await service.fetchQuota();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    credentials = claudeCredentials('replacement-token', Date.now() + 60 * 60_000);
    await service.fetchQuota();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('parseScopedClaudeLimits', () => {
  it('returns only model-scoped weekly limits with a name and percentage', () => {
    expect(parseScopedClaudeLimits([
      { kind: 'weekly_all', percent: 10, resets_at: null, scope: null },
      { kind: 'weekly_scoped', percent: 40, resets_at: null, scope: { model: { display_name: ' Fable ' } } },
      { kind: 'weekly_scoped', percent: 5, scope: { model: { display_name: '' } } },
      { kind: 'weekly_scoped', percent: 'high', scope: { model: { display_name: 'Opus' } } },
      { kind: 'weekly_scoped', percent: 12, scope: { surface: 'chat' } },
      null,
    ])).toEqual([{ label: 'Fable', utilization: 40, resetsAt: null }]);
  });

  it('returns an empty list when the endpoint omits limits', () => {
    expect(parseScopedClaudeLimits(undefined)).toEqual([]);
    expect(parseScopedClaudeLimits({})).toEqual([]);
  });
});
