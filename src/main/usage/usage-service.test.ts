import { describe, expect, it, vi } from 'vitest';
import type { SessionUsage } from '../../shared/types';

vi.mock('electron', () => ({ app: { getPath: () => '' } }));

import { resetUsageForReparse } from './usage-service';

describe('usage-service helpers', () => {
  it('resets accumulated totals while preserving session identity', () => {
    const existing: SessionUsage = {
      sessionId: 's1',
      cliTool: 'claude',
      environmentId: 'env-1',
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 25,
      cacheReadTokens: 10,
      totalCost: 1.23,
      models: [{ model: 'm', inputTokens: 100, outputTokens: 50, cacheCreationTokens: 25, cacheReadTokens: 10, cost: 1.23 }],
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
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalCost: 0,
      models: [],
      messageCount: 0,
      firstMessageAt: null,
      lastMessageAt: null,
      parsedByteOffset: 0,
    });
  });
});
