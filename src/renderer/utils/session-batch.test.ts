import { describe, expect, it, vi } from 'vitest';
import { runBatch, summarizeBatch, type BatchStepResult } from './session-batch';

const sessions = [{ label: 'api' }, { label: 'web' }, { label: 'docs' }, { label: 'infra' }];

describe('runBatch', () => {
  it('runs steps one at a time, in order', async () => {
    const events: string[] = [];
    const result = await runBatch(sessions, async item => {
      events.push(`start ${item.label}`);
      await Promise.resolve();
      events.push(`end ${item.label}`);
      return { status: 'done' };
    });
    expect(events).toEqual([
      'start api', 'end api', 'start web', 'end web', 'start docs', 'end docs', 'start infra', 'end infra',
    ]);
    expect(result.done).toEqual(sessions);
    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('records a failure and carries on with the rest', async () => {
    const error = new Error('connect ETIMEDOUT');
    const result = await runBatch(sessions, async (item): Promise<BatchStepResult> =>
      item.label === 'web' ? { status: 'failed', error } : { status: 'done' });
    expect(result.done.map(item => item.label)).toEqual(['api', 'docs', 'infra']);
    expect(result.failed).toEqual([{ item: sessions[1], error }]);
  });

  it('treats a thrown step as a failure', async () => {
    const result = await runBatch(sessions.slice(0, 2), async item => {
      if (item.label === 'api') throw new Error('boom');
      return { status: 'done' };
    });
    expect(result.failed.map(entry => entry.item.label)).toEqual(['api']);
    expect(result.done.map(item => item.label)).toEqual(['web']);
  });

  it('stops at a cancel and reports that item and the rest as skipped', async () => {
    const step = vi.fn(async (item: { label: string }): Promise<BatchStepResult> =>
      item.label === 'web' ? { status: 'cancelled' } : { status: 'done' });
    const result = await runBatch(sessions, step);
    expect(step).toHaveBeenCalledTimes(2);
    expect(result.done.map(item => item.label)).toEqual(['api']);
    expect(result.skipped.map(item => item.label)).toEqual(['web', 'docs', 'infra']);
  });
});

describe('summarizeBatch', () => {
  it('reports a clean run plainly', () => {
    expect(summarizeBatch('Restarted', { done: sessions, failed: [], skipped: [] }, 'unused'))
      .toEqual({ type: 'info', title: 'Restarted 4 sessions' });
    expect(summarizeBatch('Restored', { done: [sessions[0]], failed: [], skipped: [] }, 'unused').title)
      .toBe('Restored 1 session');
  });

  it('names what failed, why, and what happened to it', () => {
    const summary = summarizeBatch('Restarted', {
      done: sessions.slice(0, 3),
      failed: [{ item: sessions[3], error: new Error('Vault token expired') }],
      skipped: [],
    }, 'They were left as they were.');
    expect(summary).toEqual({
      type: 'warning',
      title: 'Restarted 3 of 4 sessions',
      message: '1 failed: infra (Vault token expired). They were left as they were.',
    });
  });

  it('lists sessions that were never attempted and flags a run where nothing worked', () => {
    const summary = summarizeBatch('Restored', {
      done: [],
      failed: [{ item: sessions[0], error: 'no such directory' }],
      skipped: sessions.slice(1, 3),
    }, 'Choose Retry to try them again.');
    expect(summary.type).toBe('error');
    expect(summary.title).toBe('Restored 0 of 3 sessions');
    expect(summary.message).toBe(
      '1 failed: api (no such directory). 2 not attempted: web, docs. Choose Retry to try them again.',
    );
  });

  it('omits the reason when the error carries none', () => {
    const summary = summarizeBatch('Restarted', { done: [], failed: [{ item: sessions[0], error: undefined }], skipped: [] }, 'Left running.');
    expect(summary.message).toBe('1 failed: api. Left running.');
  });
});
