import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUsage } from '../../shared/types';
import type { DbData } from '../db/database';

vi.mock('electron', () => ({ app: { getPath: () => '' } }));

const mocks = vi.hoisted(() => ({
  db: {
    environments: [],
    sessions: [],
    launchProfiles: [],
    config: {},
    defaultEnvVars: {},
    defaultCliFlags: [],
    defaultCliFlagsPerTool: {},
    savedWorkspace: null,
    gitProviders: [],
    repoGroupPrefs: [],
    sessionOrderPrefs: [],
    usageSummaries: [],
    knownHosts: [],
    keybindings: {},
  } as DbData,
  saveDb: vi.fn(),
  scanAllTranscripts: vi.fn(() => []),
  scanAllCodexTranscripts: vi.fn(() => []),
  readCrushSessions: vi.fn(() => []),
}));

vi.mock('../db/database', () => ({
  getDb: () => mocks.db,
  saveDb: mocks.saveDb,
}));

vi.mock('../claude/transcripts', () => ({
  transcriptPath: (workingDir: string, sessionId: string) => `${workingDir}/${sessionId}.jsonl`,
  scanAllTranscripts: mocks.scanAllTranscripts,
}));

vi.mock('../codex/transcripts', () => ({
  scanAllCodexTranscripts: mocks.scanAllCodexTranscripts,
}));

vi.mock('../opencode/usage-reader', () => ({
  readCrushSessions: mocks.readCrushSessions,
}));

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { mergeMessages, resetUsageForReparse, UsageService } from './usage-service';

beforeEach(() => {
  mocks.db.usageSummaries = [];
  mocks.saveDb.mockClear();
  mocks.scanAllTranscripts.mockReturnValue([]);
  mocks.scanAllCodexTranscripts.mockReturnValue([]);
  mocks.readCrushSessions.mockReturnValue([]);
});

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
      dayTiming: 'event',
      workingDir: undefined,
      contextUsedTokens: null,
      observedAt: null,
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

  it('keeps unavailable historical totals as legacy all-time usage without date buckets', () => {
    mocks.db.usageSummaries = [{
      sessionId: 'legacy',
      cliTool: 'codex',
      workingDir: 'C:\\repo\\old',
      filePath: 'C:\\repo\\missing\\rollout.jsonl',
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 5,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalCost: 0.5,
      models: [{ model: 'gpt-5-codex', inputTokens: 100, outputTokens: 20, reasoningTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0.5 }],
      messageCount: 1,
      firstMessageAt: '2026-05-08T00:00:00.000Z',
      lastMessageAt: '2026-05-08T00:01:00.000Z',
      parsedByteOffset: 123,
    }];

    const service = new UsageService();
    service.start();
    service.stop();
    const all = service.getAll();

    expect(all.totalCost).toBe(0.5);
    expect(all.daily).toEqual([]);
    expect(all.sessions.legacy.dayTiming).toBe('legacy');
    expect(all.sessions.legacy.workingDir).toBe('C:\\repo\\old');
  });

  it('forces a one-time full reparse for unchanged-size persisted transcript summaries', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const os = require('node:os') as typeof import('node:os');
    const path = require('node:path') as typeof import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-usage-reparse-'));
    const filePath = path.join(dir, 'session.jsonl');
    fs.writeFileSync(filePath, JSON.stringify({
      type: 'assistant',
      timestamp: '2026-05-08T23:00:00.000Z',
      message: { model: 'claude-sonnet-4', usage: { input_tokens: 10, output_tokens: 5 } },
    }) + '\n' + JSON.stringify({
      type: 'assistant',
      timestamp: '2026-05-09T01:00:00.000Z',
      message: { model: 'claude-sonnet-4', usage: { input_tokens: 20, output_tokens: 7 } },
    }) + '\n');
    const size = fs.statSync(filePath).size;
    mocks.db.usageSummaries = [{
      sessionId: 'reparse',
      cliTool: 'claude',
      workingDir: dir,
      filePath,
      inputTokens: 30,
      outputTokens: 12,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalCost: 0.00027,
      models: [{ model: 'claude-sonnet-4', inputTokens: 30, outputTokens: 12, reasoningTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0.00027 }],
      messageCount: 2,
      firstMessageAt: '2026-05-08T23:00:00.000Z',
      lastMessageAt: '2026-05-09T01:00:00.000Z',
      parsedByteOffset: size,
    }];

    const service = new UsageService();
    service.start();
    service.stop();
    fs.rmSync(dir, { recursive: true, force: true });

    expect(service.getAll().daily.map(d => d.date)).toEqual(['2026-05-09', '2026-05-08']);
    expect(mocks.db.usageSummaries[0].usageSchemaVersion).toBe(2);
  });

  it('attaches a discovered Codex transcript path to an initially tracked empty path', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const os = require('node:os') as typeof import('node:os');
    const path = require('node:path') as typeof import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-usage-attach-'));
    const filePath = path.join(dir, 'rollout.jsonl');
    fs.writeFileSync(filePath, [
      JSON.stringify({ type: 'session_meta', payload: { id: 'codex-empty-path', cwd: dir } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5-codex' } }),
      JSON.stringify({
        timestamp: '2026-05-09T00:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 50, output_tokens: 5 } } },
      }),
    ].join('\n') + '\n');
    mocks.scanAllCodexTranscripts.mockReturnValue([{
      sessionId: 'codex-empty-path',
      filePath,
      cwd: dir,
      size: fs.statSync(filePath).size,
      mtimeMs: Date.now(),
    }]);

    const service = new UsageService();
    service.trackSession('codex-empty-path', dir, 'codex');
    (service as unknown as { backfillFromDisk: () => void }).backfillFromDisk();
    service.stop();
    fs.rmSync(dir, { recursive: true, force: true });

    const all = service.getAll();
    expect(all.sessions['codex-empty-path'].inputTokens).toBe(50);
    expect(all.sessions['codex-empty-path'].workingDir).toBe(dir);
    expect(mocks.db.usageSummaries[0].filePath).toBe(filePath);
  });

  it('reparses a persisted empty Codex path after scan discovery even when size is unchanged', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const os = require('node:os') as typeof import('node:os');
    const path = require('node:path') as typeof import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-usage-empty-persisted-'));
    const filePath = path.join(dir, 'rollout.jsonl');
    fs.writeFileSync(filePath, [
      JSON.stringify({ type: 'session_meta', payload: { id: 'persisted-empty-path', cwd: dir } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5-codex' } }),
      JSON.stringify({
        timestamp: '2026-05-08T23:30:00.000Z',
        type: 'event_msg',
        payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 20, output_tokens: 2 } } },
      }),
      JSON.stringify({
        timestamp: '2026-05-09T00:30:00.000Z',
        type: 'event_msg',
        payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 30, output_tokens: 3 } } },
      }),
    ].join('\n') + '\n');
    mocks.db.usageSummaries = [{
      sessionId: 'persisted-empty-path',
      cliTool: 'codex',
      workingDir: dir,
      filePath: '',
      inputTokens: 50,
      outputTokens: 5,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalCost: 0.01,
      models: [{ model: 'gpt-5-codex', inputTokens: 50, outputTokens: 5, reasoningTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0.01 }],
      messageCount: 2,
      firstMessageAt: '2026-05-08T23:30:00.000Z',
      lastMessageAt: '2026-05-09T00:30:00.000Z',
      parsedByteOffset: fs.statSync(filePath).size,
    }];
    mocks.scanAllCodexTranscripts.mockReturnValue([{
      sessionId: 'persisted-empty-path',
      filePath,
      cwd: dir,
      size: fs.statSync(filePath).size,
      mtimeMs: Date.now(),
    }]);

    const service = new UsageService();
    service.start();
    (service as unknown as { backfillFromDisk: () => void }).backfillFromDisk();
    service.stop();
    fs.rmSync(dir, { recursive: true, force: true });

    const all = service.getAll();
    expect(all.sessions['persisted-empty-path'].dayTiming).toBe('event');
    expect(all.daily.map(d => d.date)).toEqual(['2026-05-09', '2026-05-08']);
    expect(mocks.db.usageSummaries[0].filePath).toBe(filePath);
  });

  it('trackSession reparses old-schema persisted Codex usage before appending to lifetime totals', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const os = require('node:os') as typeof import('node:os');
    const path = require('node:path') as typeof import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-usage-track-reparse-'));
    const filePath = path.join(dir, 'rollout.jsonl');
    fs.writeFileSync(filePath, [
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5-codex' } }),
      JSON.stringify({
        timestamp: '2026-05-08T23:30:00.000Z',
        type: 'event_msg',
        payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 20, output_tokens: 2 } } },
      }),
      JSON.stringify({
        timestamp: '2026-05-09T00:30:00.000Z',
        type: 'event_msg',
        payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 30, output_tokens: 3 } } },
      }),
    ].join('\n') + '\n');
    mocks.db.usageSummaries = [{
      sessionId: 'track-old-schema',
      cliTool: 'codex',
      workingDir: dir,
      filePath,
      inputTokens: 50,
      outputTokens: 5,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalCost: 0.01,
      models: [{ model: 'gpt-5-codex', inputTokens: 50, outputTokens: 5, reasoningTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0.01 }],
      currentModel: 'stale-model',
      messageCount: 2,
      firstMessageAt: '2026-05-08T23:30:00.000Z',
      lastMessageAt: '2026-05-09T00:30:00.000Z',
      parsedByteOffset: fs.statSync(filePath).size,
    }];

    const service = new UsageService();
    service.trackSession('track-old-schema', dir, 'codex');
    service.stop();
    fs.rmSync(dir, { recursive: true, force: true });

    const all = service.getAll();
    expect(all.sessions['track-old-schema'].inputTokens).toBe(50);
    expect(all.daily.map(d => d.date)).toEqual(['2026-05-09', '2026-05-08']);
    expect(mocks.db.usageSummaries[0].usageSchemaVersion).toBe(2);
  });

  it('does not seed reparsed Codex pre-context events with stale persisted currentModel', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const os = require('node:os') as typeof import('node:os');
    const path = require('node:path') as typeof import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-usage-stale-model-'));
    const filePath = path.join(dir, 'rollout.jsonl');
    fs.writeFileSync(filePath, JSON.stringify({
      timestamp: '2026-05-09T00:30:00.000Z',
      type: 'event_msg',
      payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 30, output_tokens: 3 } } },
    }) + '\n');
    mocks.db.usageSummaries = [{
      sessionId: 'stale-model',
      cliTool: 'codex',
      workingDir: dir,
      filePath,
      inputTokens: 30,
      outputTokens: 3,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalCost: 0.01,
      models: [{ model: 'old-latest', inputTokens: 30, outputTokens: 3, reasoningTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0.01 }],
      currentModel: 'old-latest',
      messageCount: 1,
      firstMessageAt: '2026-05-09T00:30:00.000Z',
      lastMessageAt: '2026-05-09T00:30:00.000Z',
      parsedByteOffset: fs.statSync(filePath).size,
    }];

    const service = new UsageService();
    service.start();
    service.stop();
    fs.rmSync(dir, { recursive: true, force: true });

    expect(service.getAll().sessions['stale-model'].models[0].model).toBe('unknown');
  });

  it('preserves legacy totals and schema marker when migration reparse cannot read a transient source', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const os = require('node:os') as typeof import('node:os');
    const path = require('node:path') as typeof import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-usage-unreadable-'));
    mocks.db.usageSummaries = [{
      sessionId: 'unreadable',
      cliTool: 'claude',
      workingDir: dir,
      filePath: dir,
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalCost: 0.5,
      models: [{ model: 'claude-sonnet-4', inputTokens: 100, outputTokens: 20, reasoningTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0.5 }],
      messageCount: 1,
      firstMessageAt: '2026-05-09T00:00:00.000Z',
      lastMessageAt: '2026-05-09T00:00:00.000Z',
      parsedByteOffset: 50,
    }];

    const service = new UsageService();
    service.start();
    service.stop();
    fs.rmSync(dir, { recursive: true, force: true });

    expect(service.getAll().sessions.unreadable.totalCost).toBe(0.5);
    expect(service.getAll().sessions.unreadable.dayTiming).toBe('legacy');
    expect(mocks.db.usageSummaries[0].usageSchemaVersion).toBeUndefined();
  });

  it('preserves real Claude cwd after a tracked session is matched to an encoded backfill row', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const os = require('node:os') as typeof import('node:os');
    const path = require('node:path') as typeof import('node:path');
    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-usage-real-cwd-'));
    const filePath = path.join(realDir, 'session.jsonl');
    fs.writeFileSync(filePath, JSON.stringify({
      type: 'assistant',
      timestamp: '2026-05-09T00:00:00.000Z',
      message: { model: 'claude-sonnet-4', usage: { input_tokens: 10, output_tokens: 5 } },
    }) + '\n');
    mocks.scanAllTranscripts.mockReturnValue([{
      sessionId: 'claude-cwd',
      projectDirName: '-encoded-real-cwd',
      filePath,
      size: fs.statSync(filePath).size,
      mtimeMs: Date.now(),
    }]);

    const service = new UsageService();
    (service as unknown as { backfillFromDisk: () => void }).backfillFromDisk();
    service.trackSession('claude-cwd', realDir, 'claude');
    (service as unknown as { backfillFromDisk: () => void }).backfillFromDisk();
    service.stop();
    fs.rmSync(realDir, { recursive: true, force: true });

    expect(service.getAll().sessions['claude-cwd'].workingDir).toBe(realDir);
    expect(mocks.db.usageSummaries[0].workingDir).toBe(realDir);
  });
});
