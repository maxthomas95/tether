import { describe, expect, it } from 'vitest';
import type { CliToolId, SessionUsage, UsageInfo } from '../../shared/types';
import { buildUsageExplorer, createDefaultUsageExplorerFilters, type UsageExplorerFilters } from './usage-explorer';

function model(model: string, inputTokens: number, outputTokens: number, cost: number, cacheReadTokens = 0, reasoningTokens = 0) {
  return {
    model,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheCreationTokens: 0,
    cacheReadTokens,
    cost,
  };
}

function session(overrides: Partial<SessionUsage> & { sessionId: string }): SessionUsage {
  return {
    sessionId: overrides.sessionId,
    cliTool: overrides.cliTool ?? 'codex',
    environmentId: overrides.environmentId,
    inputTokens: overrides.inputTokens ?? 0,
    outputTokens: overrides.outputTokens ?? 0,
    reasoningTokens: overrides.reasoningTokens ?? 0,
    cacheCreationTokens: overrides.cacheCreationTokens ?? 0,
    cacheReadTokens: overrides.cacheReadTokens ?? 0,
    totalCost: overrides.totalCost ?? 0,
    models: overrides.models ?? [],
    daily: overrides.daily,
    dayTiming: overrides.dayTiming,
    workingDir: overrides.workingDir,
    contextUsedTokens: overrides.contextUsedTokens,
    contextWindowTokens: overrides.contextWindowTokens,
    currentModel: overrides.currentModel,
    currentReasoningEffort: overrides.currentReasoningEffort,
    observedAt: overrides.observedAt,
    messageCount: overrides.messageCount ?? 0,
    firstMessageAt: overrides.firstMessageAt ?? null,
    lastMessageAt: overrides.lastMessageAt ?? null,
    parsedByteOffset: overrides.parsedByteOffset ?? 0,
  };
}

function usage(sessions: SessionUsage[]): UsageInfo {
  return {
    sessions: Object.fromEntries(sessions.map(value => [value.sessionId, value])),
    daily: [],
    byEnvironment: [],
    byCliTool: [],
    totalCost: sessions.reduce((sum, value) => sum + value.totalCost, 0),
    lastUpdated: null,
  };
}

function filters(overrides: Partial<UsageExplorerFilters> = {}): UsageExplorerFilters {
  return {
    ...createDefaultUsageExplorerFilters(new Date('2026-09-07T15:00:00.000Z')),
    ...overrides,
  };
}

function build(input: UsageInfo, filterOverrides: Partial<UsageExplorerFilters> = {}) {
  return buildUsageExplorer({
    usage: input,
    filters: filters(filterOverrides),
    sort: { key: 'lastActivity', direction: 'desc' },
    today: new Date('2026-09-07T15:00:00.000Z'),
  });
}

describe('buildUsageExplorer', () => {
  it('uses UTC date boundaries for today', () => {
    const result = build(usage([
      session({
        sessionId: 'utc',
        daily: [
          { date: '2026-09-07', inputTokens: 10, outputTokens: 20, cacheCreationTokens: 0, cacheReadTokens: 0, totalCost: 0.03, messageCount: 1, models: [model('gpt-5', 10, 20, 0.03)] },
          { date: '2026-09-06', inputTokens: 100, outputTokens: 200, cacheCreationTokens: 0, cacheReadTokens: 0, totalCost: 0.3, messageCount: 1, models: [model('gpt-5', 100, 200, 0.3)] },
        ],
      }),
    ]), { datePreset: 'today' });

    expect(result.dateRange).toMatchObject({ startDate: '2026-09-07', endDate: '2026-09-07' });
    expect(result.totals.cost).toBeCloseTo(0.03);
    expect(result.totals.tokens).toBe(30);
  });

  it('counts a resumed session once across two days', () => {
    const result = build(usage([
      session({
        sessionId: 'resumed',
        daily: [
          { date: '2026-09-06', inputTokens: 10, outputTokens: 20, cacheCreationTokens: 0, cacheReadTokens: 0, totalCost: 0.1, messageCount: 1, models: [model('gpt-5', 10, 20, 0.1)] },
          { date: '2026-09-07', inputTokens: 30, outputTokens: 40, cacheCreationTokens: 0, cacheReadTokens: 0, totalCost: 0.2, messageCount: 2, models: [model('gpt-5', 30, 40, 0.2)] },
        ],
      }),
    ]), { datePreset: '7d' });

    expect(result.totals.sessions).toBe(1);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].cost).toBeCloseTo(0.3);
  });

  it('filters by per-day model counters instead of lifetime totals', () => {
    const result = build(usage([
      session({
        sessionId: 'mixed',
        models: [model('gpt-5', 999, 999, 9.99), model('gpt-4.1', 999, 999, 9.99)],
        daily: [
          {
            date: '2026-09-07',
            inputTokens: 110,
            outputTokens: 220,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            totalCost: 0.33,
            messageCount: 2,
            models: [model('gpt-5', 10, 20, 0.03), model('gpt-4.1', 100, 200, 0.3)],
          },
        ],
      }),
    ]), { datePreset: 'today', models: ['gpt-5'] });

    expect(result.totals.cost).toBeCloseTo(0.03);
    expect(result.totals.tokens).toBe(30);
    expect(result.sessions[0].models).toMatchObject([{ model: 'gpt-5', cost: 0.03 }]);
  });

  it('uses the same filters for the previous equal period', () => {
    const result = build(usage([
      session({
        sessionId: 'codex-now',
        cliTool: 'codex',
        daily: [{ date: '2026-09-07', inputTokens: 10, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0, totalCost: 0.02, messageCount: 1, models: [model('gpt-5', 10, 10, 0.02)] }],
      }),
      session({
        sessionId: 'codex-prev',
        cliTool: 'codex',
        daily: [{ date: '2026-09-06', inputTokens: 50, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, totalCost: 0.1, messageCount: 1, models: [model('gpt-5', 50, 50, 0.1)] }],
      }),
      session({
        sessionId: 'claude-prev',
        cliTool: 'claude' as CliToolId,
        daily: [{ date: '2026-09-06', inputTokens: 500, outputTokens: 500, cacheCreationTokens: 0, cacheReadTokens: 0, totalCost: 1, messageCount: 1, models: [model('opus', 500, 500, 1)] }],
      }),
    ]), { datePreset: 'today', cliTools: ['codex'] });

    expect(result.totals.cost).toBeCloseTo(0.02);
    expect(result.comparison.available).toBe(true);
    expect(result.comparison.totals.cost).toBeCloseTo(0.1);
  });

  it('excludes legacy unknown-day sessions from finite charts but includes them for all time', () => {
    const input = usage([
      session({ sessionId: 'legacy', totalCost: 0.5, inputTokens: 100, outputTokens: 100, messageCount: 1, models: [model('gpt-5', 100, 100, 0.5)], dayTiming: 'legacy' }),
    ]);

    const finite = build(input, { datePreset: '30d' });
    const all = build(input, { datePreset: 'all' });

    expect(finite.totals.cost).toBe(0);
    expect(finite.daily).toHaveLength(0);
    expect(all.totals.cost).toBeCloseTo(0.5);
    expect(all.daily).toMatchObject([{ date: 'unknown', label: 'Unknown day', approximate: true }]);
  });

  it('labels snapshot days as approximate', () => {
    const result = build(usage([
      session({
        sessionId: 'snapshot',
        totalCost: 0.25,
        inputTokens: 20,
        outputTokens: 30,
        messageCount: 1,
        models: [model('gpt-5', 20, 30, 0.25)],
        dayTiming: 'snapshot',
        lastMessageAt: '2026-09-07T23:30:00.000Z',
      }),
    ]), { datePreset: 'today' });

    expect(result.totals.cost).toBeCloseTo(0.25);
    expect(result.daily).toMatchObject([{ date: '2026-09-07', approximate: true }]);
    expect(result.sessions[0].approximate).toBe(true);
  });

  it('keeps reasoning as an output subset and reports cache ratio inputs separately', () => {
    const result = build(usage([
      session({
        sessionId: 'reasoning',
        daily: [
          {
            date: '2026-09-07',
            inputTokens: 100,
            outputTokens: 200,
            reasoningTokens: 75,
            cacheCreationTokens: 30,
            cacheReadTokens: 70,
            totalCost: 0.4,
            messageCount: 1,
            models: [model('gpt-5', 100, 200, 0.4, 70, 75)],
          },
        ],
      }),
    ]), { datePreset: 'today' });

    expect(result.totals.tokens).toBe(400);
    expect(result.totals.reasoningTokens).toBe(75);
    expect(result.totals.cacheReadTokens).toBe(70);
  });
});
