import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '' } }));
vi.mock('../db/database', () => ({ getDb: vi.fn(() => ({ usageSummaries: [] })), saveDb: vi.fn() }));
vi.mock('./jsonl-parser', () => ({ parseJsonlFile: vi.fn(() => ({ messages: [], newByteOffset: 0 })) }));
vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  watchFile: vi.fn(),
  unwatchFile: vi.fn(),
}));

import { getDb, type PersistedSessionUsage } from '../db/database';

import { usageService } from './usage-service';
import { parseJsonlFile } from './jsonl-parser';
import { transcriptPath } from '../claude/transcripts';

afterEach(() => {
  usageService.dispose();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('usage-service path validation', () => {
  it.each(['remote', 'invalid-local'] as const)('restores %s summaries without reading or watching them as local transcripts', async (kind) => {
    vi.useFakeTimers();
    try {
      const summary: PersistedSessionUsage = {
        sessionId: kind === 'remote' ? 'remote:source' : '../outside', cliTool: 'claude', workingDir: '/repo',
        // A legacy path must not make a remote summary a local reader target.
        filePath: kind === 'remote' ? '/remote/transcript.jsonl' : undefined,
        remote: kind === 'remote' ? { scope: 'remote-user', path: '/remote/transcript.jsonl', nativeSessionId: 'native', identity: 'inode' } : undefined,
        inputTokens: 20, outputTokens: 3, cacheCreationTokens: 0, cacheReadTokens: 0,
        totalCost: 0.25, models: [], messageCount: 1,
        firstMessageAt: null, lastMessageAt: null, parsedByteOffset: 100,
      };
      vi.mocked(getDb).mockReturnValueOnce({ usageSummaries: [summary] } as ReturnType<typeof getDb>);
      expect(() => usageService.start()).not.toThrow();
      await usageService.refresh(summary.sessionId);
      expect(usageService.getSessionUsage(summary.sessionId)?.inputTokens).toBe(20);
      expect(parseJsonlFile).not.toHaveBeenCalled();
      expect(fs.watchFile).not.toHaveBeenCalled();
    } finally {
      usageService.dispose();
      vi.useRealTimers();
    }
  });


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

});
