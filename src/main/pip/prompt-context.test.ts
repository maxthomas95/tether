import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
vi.mock('../diagnostics/scrub', () => ({ scrubLogText: (text: string) => text }));
import { readRecentPrompt } from './prompt-context';
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
