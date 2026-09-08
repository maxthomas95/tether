import { describe, expect, it, vi } from 'vitest';
import type { SessionUsage } from '../../shared/types';

vi.mock('electron', () => ({ app: { getPath: () => '' } }));

import { mergeMessages, resetUsageForReparse } from './usage-service';

describe('usage-service helpers', () => {
  it('resets accumulated totals while preserving session identity', () => {
    const existing: SessionUsage = {
      sessionId: 's1',
      cliTool: 'claude',
      environmentId: 'env-1',
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 5,
      cacheCreationTokens: 25,
      cacheReadTokens: 10,
      totalCost: 1.23,
      models: [{ model: 'm', inputTokens: 100, outputTokens: 50, reasoningTokens: 5, cacheCreationTokens: 25, cacheReadTokens: 10, cost: 1.23 }],
      daily: [{
        date: '2026-01-01',
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 5,
        cacheCreationTokens: 25,
        cacheReadTokens: 10,
        totalCost: 1.23,
        messageCount: 3,
        models: [{ model: 'm', inputTokens: 100, outputTokens: 50, reasoningTokens: 5, cacheCreationTokens: 25, cacheReadTokens: 10, cost: 1.23 }],
      }],
      currentModel: 'm',
      currentReasoningEffort: 'high',
      contextWindowTokens: 200000,
      messageCount: 3,
      firstMessageAt: '2026-01-01T00:00:00.000Z',
      lastMessageAt: '2026-01-01T00:01:00.000Z',
      parsedByteOffset: 999,
    };

    expect(resetUsageForReparse(existing)).toEqual({
      sessionId: 's1',
      cliTool: 'claude',
      environmentId: 'env-1',
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalCost: 0,
      models: [],
      daily: [],
      currentModel: null,
      currentReasoningEffort: null,
      contextWindowTokens: null,
      messageCount: 0,
      firstMessageAt: null,
      lastMessageAt: null,
      parsedByteOffset: 0,
    });
  });

  it('keeps per-day buckets on the message event date', () => {
    const usage = mergeMessages({
      sessionId: 's1',
      cliTool: 'codex',
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalCost: 0,
      models: [],
      daily: [],
      messageCount: 0,
      firstMessageAt: null,
      lastMessageAt: null,
      parsedByteOffset: 0,
    }, [
      {
        model: 'gpt-5.6-sol',
        inputTokens: 100,
        outputTokens: 20,
        reasoningTokens: 5,
        cacheCreation5m: 0,
        cacheCreation1h: 0,
        cacheReadTokens: 50,
        timestamp: '2026-05-08T23:59:00.000Z',
        cost: 0.01,
      },
      {
        model: 'gpt-5.6-sol',
        inputTokens: 200,
        outputTokens: 30,
        reasoningTokens: 7,
        cacheCreation5m: 0,
        cacheCreation1h: 0,
        cacheReadTokens: 60,
        timestamp: '2026-05-09T00:01:00.000Z',
        cost: 0.02,
      },
    ], 123);

    expect(usage.inputTokens).toBe(300);
    expect(usage.outputTokens).toBe(50);
    expect(usage.reasoningTokens).toBe(12);
    expect(usage.currentModel).toBe('gpt-5.6-sol');
    expect(usage.lastMessageAt).toBe('2026-05-09T00:01:00.000Z');
    expect(usage.daily?.map(d => d.date)).toEqual(['2026-05-09', '2026-05-08']);
    expect(usage.daily?.[0]).toMatchObject({
      date: '2026-05-09',
      inputTokens: 200,
      outputTokens: 30,
      reasoningTokens: 7,
      cacheReadTokens: 60,
      totalCost: 0.02,
      messageCount: 1,
    });
  });
});
