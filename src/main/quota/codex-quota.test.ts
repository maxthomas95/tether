import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodexAccountSnapshot } from '../../shared/codex-types';

vi.mock('node:fs', () => ({ readFileSync: () => { throw new Error('No local credentials'); } }));
vi.mock('../logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
vi.mock('../codex/integration-service', () => ({ readCodexQuota: vi.fn() }));

import { readCodexQuota } from '../codex/integration-service';
import { QuotaService } from './quota-service';

function snapshot(): CodexAccountSnapshot {
  return {
    status: 'ready', lastUpdated: '2026-09-07T12:00:00.000Z', error: null,
    authMode: 'chatgpt', planType: 'plus', summary: null, dailyUsage: [], warnings: [],
    rateLimits: [{ id: 'codex', name: 'Codex', primary: null,
      secondary: { usedPercent: 90.5, windowMinutes: 1440, resetsAt: '2026-09-08T12:00:00.000Z' } }],
  };
}

afterEach(() => vi.clearAllMocks());

describe('Codex quota polling', () => {
  it('preserves all windows and the previous observation on a failed refresh', async () => {
    const service = new QuotaService();
    vi.mocked(readCodexQuota).mockResolvedValueOnce(snapshot());
    const first = await service.fetchQuota();
    expect(first.codex?.buckets).toEqual(snapshot().rateLimits);
    expect(first.codex?.secondary.usedPercent).toBe(90.5);
    vi.mocked(readCodexQuota).mockResolvedValueOnce({ ...snapshot(), status: 'error', error: 'Unavailable', rateLimits: [] });
    const failed = await service.fetchQuota();
    expect(failed.codex?.lastUpdated).toBe(first.codex?.lastUpdated);
    expect(failed.codex?.buckets).toEqual(first.codex?.buckets);
    expect(failed.codex?.error).toBe('Unavailable');
  });

  it('does not publish a late result after quota tracking is disabled', async () => {
    const service = new QuotaService();
    let finish!: (value: CodexAccountSnapshot) => void;
    vi.mocked(readCodexQuota).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const update = vi.fn();
    service.onUpdate(update);
    const pending = service.fetchQuota();
    service.setEnabled(false);
    finish(snapshot());
    expect((await pending).codex).toBeNull();
    expect(service.getQuota().codex).toBeNull();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('coalesces simultaneous refreshes and handles unexpected failures safely', async () => {
    const service = new QuotaService();
    vi.mocked(readCodexQuota).mockRejectedValueOnce(new Error('SECRET detail'));
    const [first, second] = await Promise.all([service.fetchQuota(), service.fetchQuota()]);
    expect(first).toEqual(second);
    expect(readCodexQuota).toHaveBeenCalledTimes(1);
    expect(first.codex?.error).not.toContain('SECRET');
    expect(first.codex?.lastUpdated).toBeNull();
  });
});
