import { describe, expect, it } from 'vitest';
import { aggregateByEnvironment } from './env-aggregator';
import type { SessionUsage } from '../../shared/types';

function mk(overrides: Partial<SessionUsage> & { sessionId: string; totalCost: number }): SessionUsage {
  return {
    cliTool: 'claude',
    inputTokens: 10,
    outputTokens: 20,
    cacheCreationTokens: 5,
    cacheReadTokens: 3,
    models: [],
    messageCount: 1,
    firstMessageAt: null,
    lastMessageAt: null,
    parsedByteOffset: 0,
    ...overrides,
  };
}

describe('aggregateByEnvironment', () => {
  it('returns an empty array for no sessions', () => {
    expect(aggregateByEnvironment([])).toEqual([]);
  });

  it('groups sessions by environmentId, sums cost / tokens / count', () => {
    const out = aggregateByEnvironment([
      mk({ sessionId: 'a', environmentId: 'env-1', totalCost: 1, inputTokens: 10, outputTokens: 20, cacheCreationTokens: 0, cacheReadTokens: 0 }),
      mk({ sessionId: 'b', environmentId: 'env-1', totalCost: 2, inputTokens: 100, outputTokens: 200, cacheCreationTokens: 50, cacheReadTokens: 25 }),
      mk({ sessionId: 'c', environmentId: 'env-2', totalCost: 5, inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 }),
    ]);

    expect(out).toHaveLength(2);
    // sorted by cost desc → env-2 ($5) before env-1 ($3)
    expect(out[0]).toEqual({
      environmentId: 'env-2',
      totalCost: 5,
      sessionCount: 1,
      totalTokens: 2,
    });
    expect(out[1]).toEqual({
      environmentId: 'env-1',
      totalCost: 3,
      sessionCount: 2,
      totalTokens: 405,
    });
  });

  it('collapses sessions without environmentId into a single null bucket', () => {
    const out = aggregateByEnvironment([
      mk({ sessionId: 'a', totalCost: 1 }),
      mk({ sessionId: 'b', environmentId: undefined, totalCost: 2 }),
      mk({ sessionId: 'c', totalCost: 3 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ environmentId: null, totalCost: 6, sessionCount: 3 });
  });

  it('handles a mix of attributed and unattributed sessions', () => {
    const out = aggregateByEnvironment([
      mk({ sessionId: 'a', environmentId: 'env-1', totalCost: 4 }),
      mk({ sessionId: 'b', totalCost: 1 }),
      mk({ sessionId: 'c', environmentId: 'env-2', totalCost: 2 }),
    ]);
    expect(out.map(r => r.environmentId)).toEqual(['env-1', 'env-2', null]);
  });

  it('sums input/output/cache tokens across all sessions in a bucket', () => {
    const [row] = aggregateByEnvironment([
      mk({
        sessionId: 'a', environmentId: 'env-1', totalCost: 0,
        inputTokens: 1, outputTokens: 2, cacheCreationTokens: 4, cacheReadTokens: 8,
      }),
      mk({
        sessionId: 'b', environmentId: 'env-1', totalCost: 0,
        inputTokens: 16, outputTokens: 32, cacheCreationTokens: 64, cacheReadTokens: 128,
      }),
    ]);
    // 1+2+4+8 + 16+32+64+128 = 255
    expect(row.totalTokens).toBe(255);
  });

  it('breaks cost ties deterministically (sessionCount desc, then environmentId asc, null last)', () => {
    const out = aggregateByEnvironment([
      mk({ sessionId: 'a', environmentId: 'env-b', totalCost: 1 }),
      mk({ sessionId: 'b', environmentId: 'env-a', totalCost: 1 }),
      mk({ sessionId: 'c', environmentId: 'env-a', totalCost: 0 }),
      mk({ sessionId: 'd', totalCost: 1 }), // null bucket, same total cost
    ]);
    // env-a has 2 sessions (count desc wins) → first
    // env-b has 1 session, env-a alone has 0… wait, actually env-a sums to 1 from one session at cost=1 plus one at cost=0 = total 1, sessionCount=2.
    // env-b totalCost=1, sessionCount=1
    // null totalCost=1, sessionCount=1
    expect(out[0].environmentId).toBe('env-a');
    // env-b vs null: same cost (1) and same count (1). environmentId asc, null last.
    expect(out[1].environmentId).toBe('env-b');
    expect(out[2].environmentId).toBe(null);
  });
});
