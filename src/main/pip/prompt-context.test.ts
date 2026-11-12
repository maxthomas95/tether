import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
vi.mock('../diagnostics/scrub', () => ({ scrubLogText: (text: string) => text }));
import { readRecentOpenCodePrompt, readRecentPrompt } from './prompt-context';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function transcript(rows: unknown[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tether-pip-test-'));
  roots.push(root);
  const file = path.join(root, 'rollout.jsonl');
  await writeFile(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  return file;
}
describe('Pip submitted prompt context', () => {
  it('uses a recent semantic Codex prompt and excludes assistant/tool output', async () => {
    const now = Date.now();
    const timestamp = new Date(now).toISOString();
    const file = await transcript([
      { timestamp, type: 'event_msg', payload: { type: 'user_message', message: 'Please fix my cable gremlin. token=private-value' } },
      { timestamp, type: 'response_item', payload: { role: 'assistant', content: 'DO NOT SHARE' } },
    ]);
    expect(await readRecentPrompt(file, now)).toBe('Please fix my cable gremlin. [REDACTED]');
  });
  it('ignores stale prompts, tool results, and Claude metadata', async () => {
    const now = Date.now();
    const file = await transcript([
      { timestamp: new Date(now - 400_000).toISOString(), type: 'user', message: { content: 'OLD' } },
      { timestamp: new Date(now).toISOString(), type: 'user', message: { content: [{ type: 'tool_result', content: 'SECRET' }] } },
      { timestamp: new Date(now).toISOString(), type: 'user', isMeta: true, message: { content: 'SYSTEM' } },
    ]);
    expect(await readRecentPrompt(file, now)).toBeNull();
  });
  it('bounds context size and tolerates a partial JSONL tail', async () => {
    const now = Date.now();
    const file = await transcript([{ timestamp: new Date(now).toISOString(), type: 'user', message: { content: 'x'.repeat(1000) } }]);
    expect((await readRecentPrompt(file, now))?.length).toBe(400);
    await writeFile(file, '\n{"type":', { flag: 'a' });
    expect((await readRecentPrompt(file, now))?.length).toBe(400);
  });
});

async function opencodeDb(rows: { messages: [string, string, number, unknown][]; parts: [string, string, string, unknown][] }) {
  const { DatabaseSync } = await import('node:sqlite');
  const root = await mkdtemp(path.join(os.tmpdir(), 'tether-pip-oc-'));
  roots.push(root);
  const file = path.join(root, 'opencode.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
  db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
  for (const [id, session, time, data] of rows.messages) {
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(id, session, time, time, typeof data === 'string' ? data : JSON.stringify(data));
  }
  for (const [id, message, session, data] of rows.parts) {
    db.prepare('INSERT INTO part VALUES (?, ?, ?, 0, 0, ?)').run(id, message, session, typeof data === 'string' ? data : JSON.stringify(data));
  }
  db.close();
  return file;
}

describe('Pip submitted prompt context from OpenCode', () => {
  it('uses the newest recent user message in this session, without synthetic or non-text parts', async () => {
    const now = Date.now();
    const file = await opencodeDb({
      messages: [
        ['msg_1', 'ses_a', now - 60_000, { role: 'user' }],
        ['msg_2', 'ses_a', now - 30_000, { role: 'user' }],
        ['msg_3', 'ses_a', now - 10_000, { role: 'assistant' }],
        ['msg_4', 'ses_b', now - 5_000, { role: 'user' }],
      ],
      parts: [
        ['prt_1', 'msg_1', 'ses_a', { type: 'text', text: 'Older prompt' }],
        ['prt_2', 'msg_2', 'ses_a', { type: 'text', text: '<system-reminder>DO NOT SHARE</system-reminder>', synthetic: true }],
        ['prt_3', 'msg_2', 'ses_a', { type: 'text', text: 'Tidy the cables. api_key=private-value' }],
        ['prt_4', 'msg_2', 'ses_a', { type: 'file', text: 'FILE CONTENTS' }],
        ['prt_5', 'msg_3', 'ses_a', { type: 'text', text: 'ASSISTANT REPLY' }],
        ['prt_6', 'msg_4', 'ses_b', { type: 'text', text: 'Other session' }],
      ],
    });
    expect(readRecentOpenCodePrompt(file, 'ses_a', now)).toBe('Tidy the cables. [REDACTED]');
    expect(readRecentOpenCodePrompt(file, 'ses_b', now)).toBe('Other session');
  });

  it('ignores stale prompts, malformed rows, unknown sessions and unusable paths, and bounds the excerpt', async () => {
    const now = Date.now();
    const file = await opencodeDb({
      messages: [
        ['msg_1', 'ses_old', now - 400_000, { role: 'user' }],
        ['msg_2', 'ses_bad', now, 'not json'],
        ['msg_3', 'ses_obj', now, { role: { nested: 'user' } }],
        ['msg_4', 'ses_long', now, { role: 'user' }],
      ],
      parts: [
        ['prt_1', 'msg_1', 'ses_old', { type: 'text', text: 'OLD' }],
        ['prt_2', 'msg_2', 'ses_bad', { type: 'text', text: 'BAD' }],
        ['prt_3', 'msg_3', 'ses_obj', { type: 'text', text: 'OBJECT ROLE' }],
        ['prt_4', 'msg_4', 'ses_long', { type: 'text', text: 'x'.repeat(5000) }],
      ],
    });
    for (const id of ['ses_old', 'ses_bad', 'ses_obj', 'ses_missing', '']) expect(readRecentOpenCodePrompt(file, id, now)).toBeNull();
    expect(readRecentOpenCodePrompt(file, 'ses_long', now)?.length).toBe(400);
    expect(readRecentOpenCodePrompt('relative/opencode.db', 'ses_long', now)).toBeNull();
    expect(readRecentOpenCodePrompt(path.join(path.dirname(file), 'missing.db'), 'ses_long', now)).toBeNull();
  });

  it('never writes to the database', async () => {
    const now = Date.now();
    const file = await opencodeDb({ messages: [['msg_1', 'ses_a', now, { role: 'user' }]], parts: [['prt_1', 'msg_1', 'ses_a', { type: 'text', text: 'Hi' }]] });
    const { statSync } = await import('node:fs');
    const before = statSync(file).mtimeMs;
    expect(readRecentOpenCodePrompt(file, 'ses_a', now)).toBe('Hi');
    expect(statSync(file).mtimeMs).toBe(before);
    expect(require('node:fs').existsSync(`${file}-wal`)).toBe(false);
  });
});
