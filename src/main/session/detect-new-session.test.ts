import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptInfo } from '../../shared/types';
import { createLogger } from '../logger';
import { detectNewSession } from './detect-new-session';

const transcript = (id: string, mtime = '2026-10-04T00:00:00Z'): TranscriptInfo => ({ id, mtime, preview: '' });
const logger = createLogger('detect-test');
const options = { claimedIds: new Set<string>(), logger, logLabel: 'test', pollIntervalMs: 50, timeoutMs: 100 };

afterEach(() => vi.useRealTimers());

describe('session transcript detection', () => {
  it('settles cancellation between polls and releases the timer', async () => {
    vi.useFakeTimers();
    const list = vi.fn().mockResolvedValue([]);
    const handle = detectNewSession({ ...options, list });
    await vi.advanceTimersByTimeAsync(0);
    handle.cancel();
    await expect(handle.promise).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(500);
    expect(list).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not claim a transcript returned after cancellation', async () => {
    let complete!: (items: TranscriptInfo[]) => void;
    const claimedIds = new Set<string>();
    const handle = detectNewSession({ ...options, claimedIds, list: () => new Promise(resolve => { complete = resolve; }) });
    handle.cancel();
    await expect(handle.promise).resolves.toBeNull();
    complete([transcript('late')]);
    await Promise.resolve();
    expect(claimedIds.size).toBe(0);
  });

  it.each(['synchronous', 'asynchronous'])('settles a %s read failure without rejecting', async (kind) => {
    const list = kind === 'synchronous'
      ? () => { throw new Error('read failed'); }
      : () => Promise.reject(new Error('read failed'));
    await expect(detectNewSession({ ...options, list }).promise).resolves.toBeNull();
  });

  it('handles a read failure on a scheduled poll', async () => {
    vi.useFakeTimers();
    const list = vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('read failed'));
    const handle = detectNewSession({ ...options, list });
    await vi.advanceTimersByTimeAsync(50);
    await expect(handle.promise).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('claims the earliest unclaimed new transcript after the initial snapshot', async () => {
    vi.useFakeTimers();
    const claimedIds = new Set(['other']);
    const list = vi.fn().mockResolvedValueOnce([transcript('existing')]).mockResolvedValueOnce([
      transcript('existing'), transcript('other'), transcript('later', '2026-10-04T00:00:02Z'), transcript('first'),
    ]);
    const handle = detectNewSession({ ...options, claimedIds, list, snapshotOnFirstTick: true });
    await vi.advanceTimersByTimeAsync(50);
    await expect(handle.promise).resolves.toBe('first');
    expect(claimedIds.has('first')).toBe(true);
  });

  it('settles a timeout without scheduling more reads', async () => {
    vi.useFakeTimers();
    const handle = detectNewSession({ ...options, list: () => [], preexistingIds: ['old'] });
    await vi.advanceTimersByTimeAsync(150);
    await expect(handle.promise).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
