import { describe, expect, it } from 'vitest';
import { serializeUsageCsv, serializeUsageJson } from './usage-exporter';
import type { SessionUsage, UsageInfo } from '../../shared/types';

type EnrichedSession = SessionUsage & { workingDir: string };

function makeSession(overrides: Partial<EnrichedSession> = {}): EnrichedSession {
  return {
    sessionId: 'sess-1',
    cliTool: 'claude',
    workingDir: 'C:\\repo\\tether',
    inputTokens: 100,
    outputTokens: 200,
    cacheCreationTokens: 50,
    cacheReadTokens: 25,
    totalCost: 1.25,
    models: [
      { model: 'claude-sonnet-4-5', inputTokens: 100, outputTokens: 200, cacheCreationTokens: 50, cacheReadTokens: 25, cost: 1.25 },
    ],
    messageCount: 4,
    firstMessageAt: '2026-05-09T08:00:00.000Z',
    lastMessageAt: '2026-05-09T09:30:00.000Z',
    parsedByteOffset: 1024,
    ...overrides,
  };
}

function makeUsageInfo(sessions: EnrichedSession[], overrides: Partial<UsageInfo> = {}): UsageInfo {
  const map: Record<string, SessionUsage> = {};
  let totalCost = 0;
  for (const s of sessions) {
    const { workingDir: _w, ...rest } = s;
    map[s.sessionId] = rest;
    totalCost += s.totalCost;
  }
  return {
    sessions: map,
    daily: [],
    byEnvironment: [],
    byCliTool: [],
    totalCost,
    lastUpdated: '2026-05-09T10:00:00.000Z',
    ...overrides,
  };
}

describe('serializeUsageCsv', () => {
  it('emits a header row even when there are no sessions', () => {
    const csv = serializeUsageCsv([]);
    const lines = csv.split('\r\n').filter(l => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('sessionId,cliTool,workingDir,firstMessageAt,lastMessageAt,messageCount,inputTokens,outputTokens,cacheCreationTokens,cacheReadTokens,totalCost');
  });

  it('serializes a single session with all numeric fields', () => {
    const csv = serializeUsageCsv([makeSession()]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toMatch(/^sessionId,/);
    expect(lines[1]).toBe(
      'sess-1,claude,C:\\repo\\tether,2026-05-09T08:00:00.000Z,2026-05-09T09:30:00.000Z,4,100,200,50,25,1.25',
    );
    // Trailing CRLF after last row
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('quotes fields containing commas, quotes, or newlines (RFC 4180)', () => {
    const csv = serializeUsageCsv([
      makeSession({ sessionId: 'a,b', workingDir: 'C:\\dir with "quote"' }),
      makeSession({ sessionId: 'c\nd', workingDir: 'plain' }),
    ]);
    expect(csv).toContain('"a,b"');
    expect(csv).toContain('"C:\\dir with ""quote"""');
    expect(csv).toContain('"c\nd"');
  });

  it('treats null timestamps as empty fields rather than the string "null"', () => {
    const csv = serializeUsageCsv([
      makeSession({ firstMessageAt: null, lastMessageAt: null }),
    ]);
    // ...claude,C:\repo\tether,,,4,...  — the two empty fields between cliTool's workingDir and messageCount
    expect(csv).toContain(',C:\\repo\\tether,,,4,');
    expect(csv).not.toContain('null');
  });

  it('orders sessions by lastMessageAt descending (most recent first)', () => {
    const older = makeSession({ sessionId: 'older', lastMessageAt: '2026-05-01T00:00:00.000Z' });
    const newer = makeSession({ sessionId: 'newer', lastMessageAt: '2026-05-09T00:00:00.000Z' });
    const csv = serializeUsageCsv([older, newer]);
    const lines = csv.split('\r\n').filter(l => l.length > 0);
    expect(lines[1]).toMatch(/^newer,/);
    expect(lines[2]).toMatch(/^older,/);
  });
});

describe('serializeUsageJson', () => {
  it('produces parseable JSON with the expected envelope', () => {
    const sessions = [makeSession()];
    const usage = makeUsageInfo(sessions, {
      daily: [{
        date: '2026-05-09',
        inputTokens: 100, outputTokens: 200,
        cacheCreationTokens: 50, cacheReadTokens: 25,
        totalCost: 1.25, sessionCount: 1,
      }],
    });
    const out = serializeUsageJson(usage, sessions, '0.4.2');
    const parsed = JSON.parse(out);

    expect(parsed.tetherVersion).toBe('0.4.2');
    expect(parsed.totalCost).toBeCloseTo(1.25);
    expect(parsed.lastUpdated).toBe('2026-05-09T10:00:00.000Z');
    expect(typeof parsed.exportedAt).toBe('string');
    expect(Date.parse(parsed.exportedAt)).not.toBeNaN();
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0].workingDir).toBe('C:\\repo\\tether');
    expect(parsed.sessions[0].models).toHaveLength(1);
    expect(parsed.daily).toHaveLength(1);
  });

  it('preserves the full per-model breakdown', () => {
    const session = makeSession({
      models: [
        { model: 'claude-sonnet-4-5', inputTokens: 50, outputTokens: 100, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0.50 },
        { model: 'claude-opus-4-7', inputTokens: 50, outputTokens: 100, cacheCreationTokens: 50, cacheReadTokens: 25, cost: 0.75 },
      ],
    });
    const out = serializeUsageJson(makeUsageInfo([session]), [session], '0.4.2');
    const parsed = JSON.parse(out);
    expect(parsed.sessions[0].models).toHaveLength(2);
    expect(parsed.sessions[0].models[1].model).toBe('claude-opus-4-7');
  });

  it('emits valid JSON for the empty case', () => {
    const out = serializeUsageJson(makeUsageInfo([]), [], '0.4.2');
    const parsed = JSON.parse(out);
    expect(parsed.sessions).toEqual([]);
    expect(parsed.daily).toEqual([]);
    expect(parsed.totalCost).toBe(0);
  });
});
