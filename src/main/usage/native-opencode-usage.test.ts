import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersistedSessionUsage } from '../db/database';
import type { SessionUsage } from '../../shared/types';

const mocks = vi.hoisted(() => ({
  db: { usageSummaries: [] as PersistedSessionUsage[] }, save: vi.fn(), command: vi.fn(), read: vi.fn(), crush: vi.fn(),
}));
vi.mock('electron', () => ({ app: { getPath: () => '' } }));
vi.mock('../db/database', () => ({ getDb: () => mocks.db, saveDb: mocks.save }));
vi.mock('../logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
vi.mock('../claude/transcripts', () => ({ transcriptPath: vi.fn(), scanAllTranscripts: () => [] }));
vi.mock('../codex/transcripts', () => ({ scanAllCodexTranscripts: () => [] }));
vi.mock('../opencode/usage-reader', () => ({ readCrushSessions: mocks.crush }));
vi.mock('../cli/metadata-command', () => ({ runCliMetadata: mocks.command }));
vi.mock('../opencode/native-usage-reader', () => ({ readNativeOpenCodeUsage: mocks.read }));
vi.mock('../opencode/native-usage-source', async importOriginal => {
  const actual = await importOriginal<typeof import('../opencode/native-usage-source')>();
  return { ...actual, NativeOpenCodeUsageSource: class {
    private pending = new Map<string, Promise<string | null>>();
    resolvePath(context: { env?: NodeJS.ProcessEnv } = {}): Promise<string | null> {
      const key = context.env?.OPENCODE_DB ?? 'default';
      if (!this.pending.has(key)) this.pending.set(key, mocks.command('opencode', [], { env: context.env })
        .then((result: { ok: boolean; stdout: string }) => result.ok ? result.stdout : null));
      return this.pending.get(key)!;
    }
  } };
});

import { UsageService } from './usage-service';

const dbPath = path.resolve('native-data/opencode.db');
const workingDir = path.resolve('native-project');
let service: UsageService;

function snapshot(id = 'ses_native', cost = 0.5): SessionUsage {
  const model = { model: 'provider/model', inputTokens: 20, outputTokens: 12, reasoningTokens: 2,
    cacheCreationTokens: 3, cacheReadTokens: 8, cost };
  return { sessionId: id, cliTool: 'opencode', usageSource: 'native-opencode', costSource: 'reported', collectionStatus: 'available',
    observedAt: '2026-10-15T12:00:00.000Z', workingDir, inputTokens: 20, outputTokens: 12, reasoningTokens: 2,
    cacheCreationTokens: 3, cacheReadTokens: 8, totalCost: cost, models: [model], dayTiming: 'event',
    daily: [{ date: '2026-10-14', inputTokens: 20, outputTokens: 12, reasoningTokens: 2,
      cacheCreationTokens: 3, cacheReadTokens: 8, totalCost: cost, messageCount: 2, models: [model] }],
    currentModel: 'provider/model', messageCount: 2, firstMessageAt: '2026-10-14T10:00:00.000Z',
    lastMessageAt: '2026-10-14T10:01:00.000Z', parsedByteOffset: 0 };
}
const ready = (...sessions: SessionUsage[]) => ({ status: 'available', sessions, unavailableSessionIds: [] });

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  mocks.db.usageSummaries = [];
  mocks.command.mockImplementation(async (_tool, _args, options) => ({ ok: true, stdout: options.env?.OPENCODE_DB ?? dbPath }));
  mocks.read.mockReturnValue(ready(snapshot()));
  mocks.crush.mockReturnValue([]);
  service = new UsageService();
});
afterEach(() => { service.dispose(); vi.useRealTimers(); });

describe('native OpenCode service integration', () => {
  it('backfills native event/model/day snapshots without changing measured zero costs', async () => {
    mocks.read.mockReturnValue(ready(snapshot('ses_native', 0)));
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    await service.refresh();
    expect(service.getSessionUsage('ses_native')).toMatchObject({ totalCost: 0, collectionStatus: 'available', costSource: 'reported', dayTiming: 'event' });
    expect(service.getAll().daily).toContainEqual(expect.objectContaining({ date: '2026-10-14', totalCost: 0, inputTokens: 20 }));
    expect(mocks.db.usageSummaries[0]).toMatchObject({ usageSource: 'native-opencode', costSource: 'reported', filePath: dbPath });
    expect(service.getLocalTranscriptPath('ses_native')).toBeNull();
  });

  it('refreshes a preloaded native session on track and preserves environment attribution', async () => {
    service.start(); await vi.advanceTimersByTimeAsync(0);
    mocks.read.mockReturnValue(ready(snapshot('ses_native', 1.25)));
    service.trackSession('ses_native', workingDir, 'opencode', 'env-local');
    await service.refresh('ses_native');
    expect(service.getSessionUsage('ses_native')).toMatchObject({ totalCost: 1.25, environmentId: 'env-local' });
    expect(service.getAll().byEnvironment).toContainEqual(expect.objectContaining({ environmentId: 'env-local', totalCost: 1.25 }));
  });

  it('replaces snapshots on repeated polls and avoids unchanged persistence writes', async () => {
    service.trackSession('ses_native', workingDir, 'opencode');
    await service.refresh('ses_native');
    const saved = mocks.save.mock.calls.length;
    await service.refresh('ses_native');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(service.getAll().totalCost).toBe(0.5);
    expect(service.getSessionUsage('ses_native')?.inputTokens).toBe(20);
    expect(mocks.save).toHaveBeenCalledTimes(saved);
  });

  it('retains successful totals during a failed read and recovers without recounting', async () => {
    service.trackSession('ses_native', workingDir, 'opencode'); await service.refresh('ses_native');
    mocks.read.mockReturnValue({ status: 'unavailable', reason: 'read-failed' });
    await service.refresh('ses_native');
    expect(service.getSessionUsage('ses_native')).toMatchObject({ totalCost: 0.5, collectionStatus: 'unavailable', observedAt: '2026-10-15T12:00:00.000Z' });
    mocks.read.mockReturnValue(ready(snapshot())); await service.refresh('ses_native');
    expect(service.getAll().totalCost).toBe(0.5);
    expect(service.getSessionUsage('ses_native')?.collectionStatus).toBe('available');
  });

  it('exposes no measurement before a successful read and omits placeholders from exports/rollups', async () => {
    mocks.read.mockReturnValue({ status: 'unavailable', reason: 'missing' });
    service.trackSession('ses_native', workingDir, 'opencode'); await service.refresh('ses_native');
    expect(service.getSessionUsage('ses_native')).toMatchObject({ collectionStatus: 'unavailable', observedAt: null });
    expect(service.getEnrichedSessions()).toEqual([]);
    expect(service.getAll().byCliTool).toEqual([]);
    expect(mocks.db.usageSummaries).toEqual([]);
  });

  it('uses each active launch database override instead of a matching ID in another source', async () => {
    const alternate = path.resolve('alternate/native.db');
    mocks.read.mockImplementation(source => ready(snapshot('ses_native', source === alternate ? 2 : 99)));
    service.trackSession('ses_native', workingDir, 'opencode', 'env', { env: { OPENCODE_DB: alternate, API_KEY: 'private' } });
    await service.refresh('ses_native');
    expect(service.getAll().totalCost).toBe(2);
    expect(mocks.db.usageSummaries[0].filePath).toBe(alternate);
    const options = mocks.command.mock.calls.map(call => call[2]);
    expect(options.some(option => option.env?.OPENCODE_DB === alternate)).toBe(true);
    expect(JSON.stringify(options)).not.toContain('private');
    service.trackSession('ses_native', workingDir, 'opencode', 'env');
    await service.refresh('ses_native');
    expect(service.getAll().totalCost).toBe(2);
  });

  it('retains invalid-session totals while accepting healthy sessions from the same database', async () => {
    service.trackSession('ses_native', workingDir, 'opencode'); await service.refresh('ses_native');
    mocks.read.mockReturnValue({ status: 'available', sessions: [snapshot('ses_healthy', 1)], unavailableSessionIds: ['ses_native'] });
    await service.refresh('ses_native');
    expect(service.getSessionUsage('ses_native')).toMatchObject({ totalCost: 0.5, collectionStatus: 'unavailable' });
    expect(service.getSessionUsage('ses_healthy')?.totalCost).toBe(1);
  });

  it('refreshes on untrack, stops polling, and retains the final totals', async () => {
    service.trackSession('ses_native', workingDir, 'opencode'); await service.refresh('ses_native');
    mocks.read.mockReturnValue(ready(snapshot('ses_native', 3)));
    service.untrackSession('ses_native'); await service.refresh('ses_native');
    expect(service.getAll().totalCost).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rebuilds from persisted native provenance after restart without double counting', async () => {
    service.trackSession('ses_native', workingDir, 'opencode'); await service.refresh('ses_native');
    service.dispose(); service = new UsageService(); service.start(); await vi.advanceTimersByTimeAsync(0);
    await service.refresh();
    expect(service.getAll().totalCost).toBe(0.5);
    expect(mocks.db.usageSummaries).toHaveLength(1);
  });

  it('does not repopulate state from metadata discovery completed after disposal', async () => {
    let finish!: (value: { ok: true; stdout: string }) => void;
    mocks.command.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    service.trackSession('ses_native', workingDir, 'opencode');
    const pending = service.refresh('ses_native'); service.dispose();
    finish({ ok: true, stdout: dbPath }); await pending;
    expect(service.getAll().sessions).toEqual({});
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it.each(['stop', 'dispose'] as const)('cancels queued startup backfill and later refresh after %s', async method => {
    service.start(); service[method]();
    await vi.advanceTimersByTimeAsync(0);
    await service.refresh();
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(service.getAll().sessions).toEqual({});
  });

  it.each([false, true])('retries discovery when an active source is added/replaced mid-refresh (replace=%s)', async replace => {
    let finish!: (value: { ok: true; stdout: string }) => void;
    const alternate = path.resolve('alternate/native.db');
    mocks.command.mockImplementation((_tool, _args, options) => options.env?.OPENCODE_DB
      ? Promise.resolve({ ok: true, stdout: alternate })
      : new Promise(resolve => { finish = resolve; }));
    mocks.read.mockImplementation(source => ready(snapshot('ses_native', source === alternate ? 2 : 99)));
    if (replace) service.trackSession('ses_native', workingDir, 'opencode');
    const pending = service.refresh();
    service.trackSession('ses_native', workingDir, 'opencode', 'env', { env: { OPENCODE_DB: alternate } });
    finish({ ok: true, stdout: dbPath });
    await pending;
    expect(service.getSessionUsage('ses_native')).toMatchObject({ collectionStatus: 'available', totalCost: 2 });
    expect(mocks.db.usageSummaries.find(summary => summary.sessionId === 'ses_native')?.totalCost).toBe(2);
  });

  it('keeps unowned duplicate IDs unavailable across repeated polls without persisting an arbitrary source', async () => {
    const alternate = path.resolve('alternate/native.db');
    mocks.read.mockImplementation(source => ready(snapshot('ses_duplicate', source === alternate ? 2 : 99)));
    service.trackSession('ses_active', workingDir, 'opencode', 'env', { env: { OPENCODE_DB: alternate } });
    await service.refresh(); await service.refresh();
    expect(service.getSessionUsage('ses_duplicate')).toMatchObject({ collectionStatus: 'unavailable', observedAt: null });
    expect(mocks.db.usageSummaries.find(summary => summary.sessionId === 'ses_duplicate')).toBeUndefined();
    expect(service.getAll().totalCost).toBe(0);
    expect(service.getEnrichedSessions()).toEqual([]);
  });
});
