import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { readNativeOpenCodeUsage } from './native-usage-reader';

const require = createRequire(import.meta.url);
let DatabaseSync: typeof import('node:sqlite').DatabaseSync | undefined;
try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* unsupported Node versions skip fixtures */ }

const CREATED = Date.parse('2026-10-01T12:00:00.000Z');
const OBSERVED = Date.parse('2026-10-15T12:00:00.000Z');
const tempDirs: string[] = [];
const handles: import('node:sqlite').DatabaseSync[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-native-usage-'));
  tempDirs.push(dir);
  return dir;
}

function fixture() {
  const dbPath = path.join(tempDir(), 'opencode.db');
  const db = new DatabaseSync!(dbPath);
  handles.push(db);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, parent_id TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
  `);
  return { dbPath, db };
}

function session(db: import('node:sqlite').DatabaseSync, id = 'session', created = CREATED - 1_000, parent: string | null = null): void {
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?)').run(id, '/repo', parent, created, OBSERVED);
}

function message(db: import('node:sqlite').DatabaseSync, id = 'message', sessionId = 'session',
  created = CREATED, data: Record<string, unknown> = {}): void {
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(id, sessionId, created, OBSERVED, JSON.stringify({
    role: 'assistant', providerID: 'provider', modelID: 'model', time: { created, completed: created + 10_000 },
    // These deliberately disagree with parts: they must never be used as totals.
    cost: 999, tokens: { input: 999, output: 999, reasoning: 999, cache: { read: 999, write: 999 } }, ...data,
  }));
}

function part(db: import('node:sqlite').DatabaseSync, id = 'part', messageId = 'message', sessionId = 'session',
  created = CREATED + 1_000, data: Record<string, unknown> = {}): void {
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run(id, messageId, sessionId, created, created, JSON.stringify({
    type: 'step-finish', cost: 0.25,
    tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 5, write: 7 } }, ...data,
  }));
}

function read(dbPath: string) {
  return readNativeOpenCodeUsage(dbPath, { now: () => OBSERVED });
}

function available(dbPath: string) {
  const result = read(dbPath);
  expect(result.status).toBe('available');
  if (result.status !== 'available') throw new Error('Expected available usage');
  return result;
}

afterEach(() => {
  for (const db of handles.splice(0)) { try { db.close(); } catch { /* fixture may already be closed */ } }
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!DatabaseSync)('readNativeOpenCodeUsage', () => {
  it('counts every step in a message and keeps reasoning and cache disjoint', () => {
    const { db, dbPath } = fixture();
    session(db);
    message(db);
    part(db, 'one');
    part(db, 'two', 'message', 'session', CREATED + 2_000, {
      cost: 0.5, tokens: { input: 100, output: 200, reasoning: 30, cache: { read: 50, write: 70 } },
    });

    expect(available(dbPath)).toEqual({ status: 'available', unavailableSessionIds: [], sessions: [{
      sessionId: 'session', cliTool: 'opencode', workingDir: '/repo', collectionStatus: 'available',
      usageSource: 'native-opencode', costSource: 'reported', observedAt: new Date(OBSERVED).toISOString(),
      inputTokens: 110, outputTokens: 253, reasoningTokens: 33, cacheReadTokens: 55, cacheCreationTokens: 77,
      totalCost: 0.75, messageCount: 2, currentModel: 'provider/model', dayTiming: 'event', parsedByteOffset: 0,
      firstMessageAt: '2026-10-01T12:00:01.000Z', lastMessageAt: '2026-10-01T12:00:02.000Z',
      models: [{ model: 'provider/model', inputTokens: 110, outputTokens: 253, reasoningTokens: 33,
        cacheReadTokens: 55, cacheCreationTokens: 77, cost: 0.75 }],
      daily: [{ date: '2026-10-01', inputTokens: 110, outputTokens: 253, reasoningTokens: 33,
        cacheReadTokens: 55, cacheCreationTokens: 77, totalCost: 0.75, messageCount: 2,
        models: [{ model: 'provider/model', inputTokens: 110, outputTokens: 253, reasoningTokens: 33,
          cacheReadTokens: 55, cacheCreationTokens: 77, cost: 0.75 }] }],
    }] });
  });

  it('uses full provider/model ids and UTC step days across a resumed message', () => {
    const { db, dbPath } = fixture();
    const before = Date.parse('2026-10-01T23:59:58Z');
    session(db);
    message(db, 'one', 'session', before, { providerID: 'a', modelID: 'shared',
      time: { created: before, completed: before + 5_000 } });
    part(db, 'before', 'one', 'session', before + 1_000);
    part(db, 'after', 'one', 'session', before + 3_000);
    message(db, 'two', 'session', before + 4_000, { providerID: 'b', modelID: 'shared' });
    part(db, 'latest', 'two', 'session', before + 5_000);
    const usage = available(dbPath).sessions[0];
    expect(usage.models.map(item => [item.model, item.cost])).toEqual([['a/shared', 0.5], ['b/shared', 0.25]]);
    expect(usage.daily?.map(day => [day.date, day.messageCount, day.totalCost])).toEqual([
      ['2026-10-01', 1, 0.25], ['2026-10-02', 2, 0.5],
    ]);
    expect(usage.currentModel).toBe('b/shared');
  });

  it('includes zero-cost usage, summary/compaction work, and children independently', () => {
    const { db, dbPath } = fixture();
    session(db, 'parent');
    session(db, 'child', CREATED - 500, 'parent');
    message(db, 'parent-message', 'parent', CREATED, { summary: true });
    message(db, 'child-message', 'child');
    part(db, 'summary-step', 'parent-message', 'parent');
    part(db, 'compaction', 'parent-message', 'parent', CREATED + 1_000, { type: 'compaction' });
    part(db, 'free-child-step', 'child-message', 'child', CREATED + 1_000, { cost: 0 });
    expect(available(dbPath).sessions.map(item => [item.sessionId, item.messageCount, item.totalCost, item.inputTokens]))
      .toEqual([['child', 1, 0, 10], ['parent', 1, 0.25, 10]]);
  });

  it('returns measured zero for a valid empty session and never derives usage from message totals', () => {
    const { db, dbPath } = fixture();
    session(db);
    const empty = available(dbPath).sessions[0];
    expect(empty).toMatchObject({ totalCost: 0, messageCount: 0, models: [], daily: [], firstMessageAt: null,
      lastMessageAt: null, collectionStatus: 'available', usageSource: 'native-opencode', costSource: 'reported' });
    message(db);
    expect(available(dbPath).sessions[0]).toEqual(empty);
  });

  it('produces replacement snapshots that are identical on repeated polls', () => {
    const { db, dbPath } = fixture();
    session(db);
    message(db);
    part(db);
    const first = read(dbPath);
    expect(read(dbPath)).toEqual(first);
    part(db, 'new-step');
    expect(available(dbPath).sessions[0]).toMatchObject({ inputTokens: 20, totalCost: 0.5, messageCount: 2 });
    expect(read(dbPath)).toEqual(read(dbPath));
  });

  it('ignores copied fork history despite fresh message/part persistence times', () => {
    const { db, dbPath } = fixture();
    session(db, 'fork', CREATED + 5_000);
    message(db, 'copied', 'fork', CREATED);
    db.prepare('UPDATE message SET time_created = ?, time_updated = ? WHERE id = ?')
      .run(CREATED + 6_000, CREATED + 6_000, 'copied');
    part(db, 'copied-step', 'copied', 'fork', CREATED + 6_000);
    message(db, 'new', 'fork', CREATED + 7_000);
    part(db, 'new-step', 'new', 'fork', CREATED + 8_000);
    expect(available(dbPath).sessions[0]).toMatchObject({ messageCount: 1, totalCost: 0.25,
      firstMessageAt: '2026-10-01T12:00:08.000Z', dayTiming: 'event' });
  });

  it('withholds equal-time usage whose fork provenance is ambiguous, including zero usage', () => {
    const { db, dbPath } = fixture();
    session(db, 'ambiguous', CREATED);
    session(db, 'healthy');
    message(db, 'equal', 'ambiguous', CREATED);
    part(db, 'zero-step', 'equal', 'ambiguous', CREATED + 1_000, {
      cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    const result = available(dbPath);
    expect(result.unavailableSessionIds).toEqual(['ambiguous']);
    expect(result.sessions.map(item => item.sessionId)).toEqual(['healthy']);
  });

  it('accepts equal-time messages without a usage step', () => {
    const { db, dbPath } = fixture();
    session(db, 'session', CREATED);
    message(db);
    part(db, 'text', 'message', 'session', CREATED + 1_000, { type: 'text', text: 'private content' });
    expect(available(dbPath).sessions[0]).toMatchObject({ messageCount: 0, dayTiming: 'event' });
  });

  it('attributes imported parts after completion to original message day with approximate timing', () => {
    const { db, dbPath } = fixture();
    session(db);
    message(db);
    part(db, 'imported', 'message', 'session', OBSERVED);
    expect(available(dbPath).sessions[0]).toMatchObject({ dayTiming: 'snapshot',
      firstMessageAt: '2026-10-01T12:00:00.000Z', lastMessageAt: '2026-10-01T12:00:00.000Z',
      daily: [{ date: '2026-10-01', messageCount: 1 }] });
  });

  it('uses approximate original message timing for unfinished messages imported with new part timestamps', () => {
    const { db, dbPath } = fixture();
    session(db);
    message(db, 'incomplete', 'session', CREATED, { time: { created: CREATED } });
    part(db, 'later', 'incomplete', 'session', OBSERVED);
    expect(available(dbPath).sessions[0]).toMatchObject({ dayTiming: 'snapshot',
      firstMessageAt: '2026-10-01T12:00:00.000Z', lastMessageAt: '2026-10-01T12:00:00.000Z',
      daily: [{ date: '2026-10-01', messageCount: 1 }],
    });
  });

  it('uses exact part time at completed message boundaries', () => {
    const { db, dbPath } = fixture();
    session(db);
    message(db, 'complete');
    part(db, 'boundary', 'complete', 'session', CREATED + 10_000);
    expect(available(dbPath).sessions[0]).toMatchObject({ dayTiming: 'event',
      firstMessageAt: '2026-10-01T12:00:10.000Z', lastMessageAt: '2026-10-01T12:00:10.000Z', daily: [
      { date: '2026-10-01', messageCount: 1 },
    ] });
  });

  it.each([
    ['negative', { input: -1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }],
    ['fractional', { input: 0.5, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }],
    ['unsafe', { input: Number.MAX_SAFE_INTEGER + 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }],
    ['missing', { output: 0, reasoning: 0, cache: { read: 0, write: 0 } }],
    ['string', { input: '10', output: 0, reasoning: 0, cache: { read: 0, write: 0 } }],
    ['object', { input: { secret: 'private content' }, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }],
    ['output-overflow', { input: 0, output: Number.MAX_SAFE_INTEGER, reasoning: 1, cache: { read: 0, write: 0 } }],
    ['missing-cache', { input: 0, output: 0, reasoning: 0, cache: { read: 0 } }],
    ['missing-reasoning', { input: 0, output: 0, cache: { read: 0, write: 0 } }],
  ])('withholds only the session with %s counters', (_label, tokens) => {
    const { db, dbPath } = fixture();
    session(db, 'bad');
    session(db, 'healthy');
    message(db, 'bad-message', 'bad');
    part(db, 'bad-step', 'bad-message', 'bad', CREATED + 1_000, { tokens });
    const result = available(dbPath);
    expect(result.unavailableSessionIds).toEqual(['bad']);
    expect(result.sessions.map(item => item.sessionId)).toEqual(['healthy']);
    expect(JSON.stringify(result)).not.toContain('private content');
  });

  it.each([
    ['negative-cost', "UPDATE part SET data = json_set(data, '$.cost', -1)"],
    ['missing-cost', "UPDATE part SET data = json_remove(data, '$.cost')"],
    ['infinite-cost', "UPDATE part SET data = replace(data, '0.25', '1e999')"],
    ['infinite-counter', "UPDATE part SET data = json_set(data, '$.tokens.input', json('1e999'))"],
    ['invalid-json', "UPDATE part SET data = '{private content'"],
    ['missing-provider', "UPDATE message SET data = json_remove(data, '$.providerID')"],
    ['missing-model', "UPDATE message SET data = json_remove(data, '$.modelID')"],
    ['invalid-message-json', "UPDATE message SET data = '{private content'"],
    ['missing-role', "UPDATE message SET data = json_remove(data, '$.role')"],
    ['negative-created', "UPDATE message SET data = json_set(data, '$.time.created', -1)"],
    ['unsafe-created', "UPDATE message SET data = json_set(data, '$.time.created', 9007199254740992)"],
    ['invalid-completed', "UPDATE message SET data = json_set(data, '$.time.completed', null)"],
    ['reversed-completed', `UPDATE message SET data = json_set(data, '$.time.completed', ${CREATED - 1})`],
    ['before-message', `UPDATE part SET time_created = ${CREATED - 1}`],
    ['invalid-part-created', "UPDATE part SET time_created = 'not a timestamp'"],
    ['invalid-part-updated', 'UPDATE part SET time_updated = -1'],
    ['invalid-session-created', 'UPDATE session SET time_created = -1'],
    ['missing-directory', 'UPDATE session SET directory = NULL'],
    ['orphan-part', "UPDATE part SET message_id = 'missing'"],
  ])('withholds identifiable sessions for %s metadata', (_label, sql) => {
    const { db, dbPath } = fixture();
    session(db, 'bad');
    message(db, 'bad-message', 'bad');
    part(db, 'bad-step', 'bad-message', 'bad');
    db.exec(sql);
    session(db, 'healthy');
    const result = available(dbPath);
    expect(result.unavailableSessionIds).toEqual(['bad']);
    expect(result.sessions.map(item => item.sessionId)).toEqual(['healthy']);
    expect(JSON.stringify(result)).not.toContain('private content');
  });

  it('withholds the session if otherwise valid step sums overflow safe counters', () => {
    const { db, dbPath } = fixture();
    session(db);
    message(db);
    part(db, 'one', 'message', 'session', CREATED + 1_000, {
      tokens: { input: Number.MAX_SAFE_INTEGER, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    part(db, 'two');
    expect(available(dbPath)).toEqual({ status: 'available', sessions: [], unavailableSessionIds: ['session'] });
  });

  it('never projects transcript text, prompts, tool output, or unrelated part content', () => {
    const { db, dbPath } = fixture();
    session(db);
    message(db, 'message', 'session', CREATED, { content: 'PRIVATE PROMPT', summary: true,
      toolOutput: 'PRIVATE TOOL OUTPUT', irrelevant: { secret: 'PRIVATE SECRET' } });
    part(db, 'usage', 'message', 'session', CREATED + 1_000, { text: 'PRIVATE STEP TEXT' });
    part(db, 'tool', 'message', 'session', CREATED + 2_000, { type: 'tool', state: { output: 'PRIVATE TOOL CONTENT' } });
    const result = available(dbPath);
    expect(result.sessions[0].messageCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('reports every truncation visibly and accepts exact record/session boundaries', () => {
    const { db, dbPath } = fixture();
    session(db);
    message(db);
    part(db);
    expect(readNativeOpenCodeUsage(dbPath, { maxSessions: 0 })).toEqual({ status: 'unavailable', reason: 'limit' });
    expect(readNativeOpenCodeUsage(dbPath, { maxRecords: 0 })).toEqual({ status: 'unavailable', reason: 'limit' });
    expect(readNativeOpenCodeUsage(dbPath, { maxRecords: 1 })).toEqual({ status: 'unavailable', reason: 'limit' });
    expect(readNativeOpenCodeUsage(dbPath, { maxSessions: 1, maxRecords: 2 }).status).toBe('available');
    part(db, 'non-usage', 'message', 'session', CREATED + 1_000, { type: 'text', text: 'private' });
    expect(readNativeOpenCodeUsage(dbPath, { maxRecords: 2 })).toEqual({ status: 'unavailable', reason: 'limit' });
  });

  it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER])('rejects invalid bounds %s', bound => {
    const { dbPath } = fixture();
    expect(readNativeOpenCodeUsage(dbPath, { maxRecords: bound })).toEqual({ status: 'unavailable', reason: 'limit' });
    expect(readNativeOpenCodeUsage(dbPath, { maxSessions: bound })).toEqual({ status: 'unavailable', reason: 'limit' });
  });

  it('rejects unsafe path forms and missing files without creating a database', () => {
    const dir = tempDir();
    const missing = path.join(dir, 'missing.db');
    expect(read(missing)).toEqual({ status: 'unavailable', reason: 'missing' });
    expect(fs.existsSync(missing)).toBe(false);
    expect(read(':memory:')).toEqual({ status: 'unavailable', reason: 'unsupported' });
    expect(read('relative.db')).toEqual({ status: 'unavailable', reason: 'unsupported' });
    expect(read('')).toEqual({ status: 'unavailable', reason: 'unsupported' });
    expect(read(dir)).toEqual({ status: 'unavailable', reason: 'unsupported' });
  });

  it('reports corrupt and unsupported schemas with safe reason codes', () => {
    const corrupt = path.join(tempDir(), 'corrupt.db');
    fs.writeFileSync(corrupt, 'PRIVATE corrupt contents');
    expect(read(corrupt)).toEqual({ status: 'unavailable', reason: 'read-failed' });
    const { db, dbPath } = fixture();
    db.exec('ALTER TABLE message RENAME COLUMN data TO changed_data');
    expect(read(dbPath)).toEqual({ status: 'unavailable', reason: 'unsupported' });
    const empty = path.join(tempDir(), 'empty.db');
    new DatabaseSync!(empty).close();
    expect(read(empty)).toEqual({ status: 'unavailable', reason: 'unsupported' });
  });

  it('reports unidentifiable rows as unavailable instead of publishing partial totals', () => {
    const { db, dbPath } = fixture();
    session(db);
    message(db);
    part(db);
    db.exec('UPDATE part SET session_id = NULL');
    expect(read(dbPath)).toEqual({ status: 'unavailable', reason: 'read-failed' });
  });

  it('does not change the database bytes, schema, or rows when reading or failing', () => {
    const { db, dbPath } = fixture();
    session(db);
    message(db);
    part(db);
    db.close();
    const digest = () => createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');
    const before = digest();
    expect(available(dbPath).sessions).toHaveLength(1);
    expect(readNativeOpenCodeUsage(dbPath, { maxRecords: 0 })).toEqual({ status: 'unavailable', reason: 'limit' });
    expect(digest()).toBe(before);
    expect(fs.readdirSync(path.dirname(dbPath))).toEqual(['opencode.db']);
  });
});
