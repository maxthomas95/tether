import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionUsage } from '../../shared/types';

vi.mock('electron', () => ({ app: { getPath: () => '' } }));
vi.mock('../db/database', () => ({ getDb: () => ({ usageSummaries: [] }), saveDb: vi.fn() }));
vi.mock('./jsonl-parser', () => ({ parseJsonlFile: vi.fn(() => ({ messages: [], newByteOffset: 0 })) }));
vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  watchFile: vi.fn(),
  unwatchFile: vi.fn(),
}));

import { resetUsageForReparse, usageService } from './usage-service';
import { parseJsonlFile } from './jsonl-parser';
import { transcriptPath } from '../claude/transcripts';

afterEach(() => {
  usageService.dispose();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('usage-service helpers', () => {
  it.each([
    ['../outside', '/repo'],
    ['..\\outside', '/repo'],
    ['00000000-0000-4000-8000-000000000001', '..'],
  ])('does not read or watch invalid Claude metadata %j in %j', (sessionId, cwd) => {
    const watch = vi.spyOn(fs, 'watchFile').mockImplementation(() => undefined as never);
    expect(() => usageService.trackSession(sessionId, cwd)).not.toThrow();
    expect(watch).not.toHaveBeenCalled();
    expect(parseJsonlFile).not.toHaveBeenCalled();
  });

  it('still starts a watcher for a valid transcript that has not been created yet', () => {
    const sessionId = '00000000-0000-4000-8000-000000000002';
    const cwd = path.join(os.tmpdir(), 'tether-usage-test');
    const watch = vi.spyOn(fs, 'watchFile').mockImplementation(() => undefined as never);
    usageService.trackSession(sessionId, cwd);
    expect(watch).toHaveBeenCalledWith(transcriptPath(cwd, sessionId), expect.any(Object), expect.any(Function));
    expect(parseJsonlFile).toHaveBeenCalledWith(transcriptPath(cwd, sessionId), 0);
  });

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
