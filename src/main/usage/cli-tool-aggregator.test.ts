import { describe, expect, it } from 'vitest';
import { aggregateByCliTool } from './cli-tool-aggregator';
import type { SessionUsage } from '../../shared/types';
import type { CliToolId } from '../../shared/cli-tools';

function mk(overrides: Partial<SessionUsage> & { sessionId: string; cliTool: CliToolId; totalCost: number }): SessionUsage {
  return {
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

describe('aggregateByCliTool', () => {
  it('returns an empty array for no sessions', () => {
    expect(aggregateByCliTool([])).toEqual([]);
  });

  it('returns a single row when all sessions share one tool', () => {
    const out = aggregateByCliTool([
      mk({ sessionId: 'a', cliTool: 'claude', totalCost: 1, inputTokens: 10, outputTokens: 20, cacheCreationTokens: 0, cacheReadTokens: 0 }),
      mk({ sessionId: 'b', cliTool: 'claude', totalCost: 2, inputTokens: 100, outputTokens: 200, cacheCreationTokens: 50, cacheReadTokens: 25 }),
    ]);
    expect(out).toEqual([
      { cliTool: 'claude', totalCost: 3, sessionCount: 2, totalTokens: 405 },
    ]);
  });

  it('groups sessions by cliTool, sums cost / tokens / count', () => {
    const out = aggregateByCliTool([
      mk({ sessionId: 'a', cliTool: 'claude', totalCost: 1, inputTokens: 10, outputTokens: 20, cacheCreationTokens: 0, cacheReadTokens: 0 }),
      mk({ sessionId: 'b', cliTool: 'claude', totalCost: 2, inputTokens: 100, outputTokens: 200, cacheCreationTokens: 50, cacheReadTokens: 25 }),
      mk({ sessionId: 'c', cliTool: 'codex', totalCost: 5, inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 }),
    ]);

    expect(out).toHaveLength(2);
    // sorted by cost desc → codex ($5) before claude ($3)
    expect(out[0]).toEqual({
      cliTool: 'codex',
      totalCost: 5,
      sessionCount: 1,
      totalTokens: 2,
    });
    expect(out[1]).toEqual({
      cliTool: 'claude',
      totalCost: 3,
      sessionCount: 2,
      totalTokens: 405,
    });
  });

  it('sorts by totalCost desc across multiple tools', () => {
    const out = aggregateByCliTool([
      mk({ sessionId: 'a', cliTool: 'opencode', totalCost: 0.5 }),
      mk({ sessionId: 'b', cliTool: 'claude', totalCost: 10 }),
      mk({ sessionId: 'c', cliTool: 'codex', totalCost: 3 }),
      mk({ sessionId: 'd', cliTool: 'copilot', totalCost: 7 }),
    ]);
    expect(out.map(r => r.cliTool)).toEqual(['claude', 'copilot', 'codex', 'opencode']);
  });

  it('sums input/output/cache tokens across all sessions in a bucket', () => {
    const [row] = aggregateByCliTool([
      mk({
        sessionId: 'a', cliTool: 'claude', totalCost: 0,
        inputTokens: 1, outputTokens: 2, cacheCreationTokens: 4, cacheReadTokens: 8,
      }),
      mk({
        sessionId: 'b', cliTool: 'claude', totalCost: 0,
        inputTokens: 16, outputTokens: 32, cacheCreationTokens: 64, cacheReadTokens: 128,
      }),
    ]);
    // 1+2+4+8 + 16+32+64+128 = 255
    expect(row.totalTokens).toBe(255);
  });

  it('breaks cost ties deterministically (sessionCount desc, then cliTool asc)', () => {
    const out = aggregateByCliTool([
      mk({ sessionId: 'a', cliTool: 'codex', totalCost: 1 }),
      mk({ sessionId: 'b', cliTool: 'claude', totalCost: 1 }),
      mk({ sessionId: 'c', cliTool: 'claude', totalCost: 0 }),
      mk({ sessionId: 'd', cliTool: 'copilot', totalCost: 1 }),
    ]);
    // claude has 2 sessions at totalCost=1 → wins via sessionCount desc
    expect(out[0].cliTool).toBe('claude');
    expect(out[0].sessionCount).toBe(2);
    // codex vs copilot: same cost (1) and same count (1). cliTool asc → codex first.
    expect(out[1].cliTool).toBe('codex');
    expect(out[2].cliTool).toBe('copilot');
  });

  it('preserves cliTool field on each output row', () => {
    const out = aggregateByCliTool([
      mk({ sessionId: 'a', cliTool: 'custom', totalCost: 1 }),
    ]);
    expect(out[0].cliTool).toBe('custom');
  });
});
