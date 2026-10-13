import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { residentProbe, subagentFixture, SESSION_ID, type SubagentFixture } from './remote-probe.test-helper';
import { createSubagentScan, foldSubagentLines } from '../claude/subagents';
import type { RemoteSubagentFile, RemoteSubagentListReply, RemoteSubagentTranscriptReply } from './remote-protocol';

type Reply<T> = T & { error?: string };
const fixtures: SubagentFixture[] = [];
function setup(project?: string) {
  const f = subagentFixture(project);
  fixtures.push(f);
  return f;
}
afterEach(() => { while (fixtures.length) fixtures.pop()!.cleanup(); });

/** One assistant record whose response id carries `n`, so a slimmed line can be told apart by id. */
const line = (n: number, pad = 0) => JSON.stringify({
  type: 'assistant', timestamp: '2026-01-01T12:00:00Z',
  message: { id: `m${n}`, model: 'claude-test-model', content: [{ type: 'text', text: 'p'.repeat(pad) }], usage: { input_tokens: 1, output_tokens: 2 } },
}) + '\n';
const text = (file: { text: string }) => file.text;
/** The response ids of the (slim or raw) lines in a text, in order. */
const ids = (t: string) => t.split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l).message.id as string]; } catch { return []; } });
const agent = (reply: RemoteSubagentListReply, id: string): RemoteSubagentFile => reply.agents.find(a => a.id === id)!;

describe('resident reader: subagent listing', () => {
  it('finds the session folder by id when the project name cannot be recomputed, and hints it back', () => {
    const f = setup();
    f.append('a1', line(1));
    const probe = residentProbe();
    const first = probe.ask<RemoteSubagentListReply>(f.request());
    expect(first).toMatchObject({ op: 'subagents', status: 'ready', found: true, project: f.project, total: 1 });
    expect(ids(text(agent(first, 'a1')))).toEqual(['m1']);
    // With the hint, a request still works even when other projects also hold the id.
    fs.mkdirSync(path.join(f.home, 'projects', 'other', SESSION_ID, 'subagents'), { recursive: true });
    expect(probe.ask<RemoteSubagentListReply>(f.request()).found).toBe(false);
    expect(probe.ask<RemoteSubagentListReply>(f.request({ project: f.project })).found).toBe(true);
  });

  it('reports a missing folder without error, and never accepts a hint that leaves the projects folder', () => {
    const f = setup();
    fs.rmSync(f.dir, { recursive: true });
    const probe = residentProbe();
    expect(probe.ask<RemoteSubagentListReply>(f.request())).toMatchObject({ found: false, agents: [], total: 0 });
    fs.mkdirSync(path.join(f.home, 'outside', SESSION_ID, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(f.home, 'outside', SESSION_ID, 'subagents', 'agent-x.jsonl'), line(1));
    const hinted = probe.ask<RemoteSubagentListReply>(f.request({ project: '../outside' }));
    expect(hinted.found).toBe(false);
  });

  it('returns only bytes after the held offset, and only meta that changed', () => {
    const f = setup();
    f.append('a1', line(1) + line(2));
    f.meta('a1', { agentType: 'tester', description: 'synthetic' });
    const probe = residentProbe();
    const first = probe.ask<RemoteSubagentListReply>(f.request());
    const a = agent(first, 'a1');
    expect(ids(text(a))).toEqual(['m1', 'm2']);
    // Offsets stay raw file bytes even though the text is slimmed.
    expect(a.offset).toBe(Buffer.byteLength(line(1) + line(2)));
    expect(JSON.parse(a.meta!)).toMatchObject({ agentType: 'tester' });

    const known = { a1: { offset: a.offset, metaMtimeMs: a.metaMtimeMs } };
    const idle = agent(probe.ask<RemoteSubagentListReply>(f.request({ known })), 'a1');
    expect(idle).toMatchObject({ text: '', offset: a.offset });
    expect(idle.meta).toBeUndefined();

    f.append('a1', line(3));
    const next = agent(probe.ask<RemoteSubagentListReply>(f.request({ known })), 'a1');
    expect(ids(text(next))).toEqual(['m3']);
    expect(next.offset).toBe(Buffer.byteLength(line(1) + line(2) + line(3)));
  });

  it('holds back a partial trailing line until its newline arrives', () => {
    const f = setup();
    const whole = line(2, 20);
    f.append('a1', line(1) + whole.slice(0, 15));
    const probe = residentProbe();
    const first = agent(probe.ask<RemoteSubagentListReply>(f.request()), 'a1');
    expect(ids(text(first))).toEqual(['m1']);
    expect(first.offset).toBe(Buffer.byteLength(line(1)));

    const known = { a1: { offset: first.offset, metaMtimeMs: first.metaMtimeMs } };
    const stalled = probe.ask<RemoteSubagentListReply>(f.request({ known }));
    expect(agent(stalled, 'a1')).toMatchObject({ text: '', offset: first.offset });
    expect(stalled.more).toBe(false);

    f.append('a1', whole.slice(15) + line(3));
    const done = agent(probe.ask<RemoteSubagentListReply>(f.request({ known })), 'a1');
    expect(ids(text(done))).toEqual(['m2', 'm3']);
  });

  it('restarts from zero when the file is shorter than the held offset', () => {
    const f = setup();
    f.append('a1', line(1));
    const probe = residentProbe();
    const reply = probe.ask<RemoteSubagentListReply>(f.request({ known: { a1: { offset: 9999, metaMtimeMs: 0 } } }));
    expect(agent(reply, 'a1')).toMatchObject({ reset: true, offset: Buffer.byteLength(line(1)) });
    expect(ids(text(agent(reply, 'a1')))).toEqual(['m1']);
  });

  it('caps each response, flags the rest as more, and drains every line exactly once in order', () => {
    const f = setup();
    // 3 files of ~6 MiB: more than the 8 MiB raw read budget, and more slim text than the 1 MiB output budget.
    const lines = (id: string) => Array.from({ length: 2000 }, (_, i) => line(i, 3000).replace(/"m(\d+)"/, `"${id}-$1"`));
    const bodies: Record<string, string[]> = {};
    for (const id of ['a1', 'a2', 'a3']) { bodies[id] = lines(id); f.append(id, bodies[id].join('')); }
    const probe = residentProbe();
    const got = new Map<string, string[]>();
    const known: Record<string, { offset: number; metaMtimeMs: number }> = {};
    let rounds = 0;
    for (;;) {
      const reply = probe.ask<RemoteSubagentListReply>(f.request({ known }));
      rounds++;
      expect(reply.agents.reduce((n, a) => n + a.text.length, 0)).toBeLessThanOrEqual(1024 * 1024);
      for (const a of reply.agents) {
        got.set(a.id, [...(got.get(a.id) ?? []), ...ids(a.text)]);
        known[a.id] = { offset: a.offset, metaMtimeMs: a.metaMtimeMs };
      }
      if (!reply.more) break;
      expect(rounds).toBeLessThan(60);
    }
    expect(rounds).toBeGreaterThan(2);
    for (const id of ['a1', 'a2', 'a3']) expect(got.get(id)).toEqual(Array.from({ length: 2000 }, (_, i) => `${id}-${i}`));
    for (const id of ['a1', 'a2', 'a3']) expect(known[id].offset).toBe(fs.statSync(path.join(f.dir, `agent-${id}.jsonl`)).size);
  });

  it('keeps the newest 50 agents and reports the real count', () => {
    const f = setup();
    for (let i = 0; i < 60; i++) {
      f.append(`a${i}`, line(i));
      const when = new Date(Date.UTC(2026, 0, 1, 0, 0, i));
      fs.utimesSync(path.join(f.dir, `agent-a${i}.jsonl`), when, when);
    }
    const reply = residentProbe().ask<RemoteSubagentListReply>(f.request());
    expect(reply.total).toBe(60);
    expect(reply.agents).toHaveLength(50);
    expect(reply.agents[0].id).toBe('a59');
    expect(reply.agents.at(-1)!.id).toBe('a10');
  });

  it('skips a line too large to carry instead of stalling on it', () => {
    const f = setup();
    f.append('a1', line(1) + line(2, 5 * 1024 * 1024) + line(3));
    const probe = residentProbe();
    const known: Record<string, { offset: number; metaMtimeMs: number }> = {};
    let received = '';
    for (let round = 0; round < 20; round++) {
      const reply = probe.ask<RemoteSubagentListReply>(f.request({ known }));
      const a = agent(reply, 'a1');
      received += text(a);
      known.a1 = { offset: a.offset, metaMtimeMs: a.metaMtimeMs };
      if (!reply.more) break;
    }
    expect(known.a1.offset).toBe(fs.statSync(path.join(f.dir, 'agent-a1.jsonl')).size);
    expect(ids(received)).toEqual(['m1', 'm3']);
  });

  it('answers a bad request with a generic error and keeps serving', () => {
    const f = setup();
    f.append('a1', line(1));
    const probe = residentProbe();
    for (const bad of [{ sessionId: '../../etc' }, { sessionId: 'not-a-uuid' }, { cli: 'codex' }]) {
      const reply = probe.ask<Reply<object>>(f.request(bad));
      expect(reply).toMatchObject({ error: 'remote-read-failed' });
      // No path, no exception text.
      expect(JSON.stringify(reply)).not.toContain(f.home);
    }
    expect(probe.ask<RemoteSubagentListReply>(f.request()).found).toBe(true);
  });

  it('does not list files that are not agent transcripts', () => {
    const f = setup();
    f.append('a1', line(1));
    fs.writeFileSync(path.join(f.dir, 'notes.txt'), 'private');
    fs.writeFileSync(path.join(f.dir, 'agent-..%2f.jsonl'), line(9));
    fs.mkdirSync(path.join(f.dir, 'agent-dir.jsonl'));
    expect(residentProbe().ask<RemoteSubagentListReply>(f.request()).agents.map(a => a.id)).toEqual(['a1']);
  });
});

describe('resident reader: subagent transcript', () => {
  const ask = (probe: ReturnType<typeof residentProbe>, f: SubagentFixture, extra: object) =>
    probe.ask<RemoteSubagentTranscriptReply>(f.request({ op: 'subagent-transcript', ...extra }));

  it('pages a transcript in bounded chunks that rejoin to the file', () => {
    const f = setup();
    const body = Array.from({ length: 2500 }, (_, i) => line(i, 800)).join('');
    f.append('a1', body);
    const probe = residentProbe();
    let offset = 0;
    let joined = '';
    for (let round = 0; round < 10; round++) {
      const reply = ask(probe, f, { agentId: 'a1', offset });
      expect(Buffer.byteLength(reply.text)).toBeLessThanOrEqual(1024 * 1024);
      joined += reply.text;
      offset = reply.offset;
      if (!reply.more) break;
    }
    expect(joined).toBe(body);
    expect(offset).toBe(Buffer.byteLength(body));
  });

  it('serves only complete lines, so a live write is picked up on the next request', () => {
    const f = setup();
    f.append('a1', line(1) + line(2).slice(0, 10));
    const probe = residentProbe();
    const first = ask(probe, f, { agentId: 'a1', offset: 0 });
    expect(first.text).toBe(line(1));
    expect(first.more).toBe(false);
    f.append('a1', line(2).slice(10));
    const second = ask(probe, f, { agentId: 'a1', offset: first.offset });
    expect(second.text).toBe(line(2));
  });

  it('reports a missing agent, rejects unsafe ids, and signals a shrunk file', () => {
    const f = setup();
    f.append('a1', line(1));
    const probe = residentProbe();
    expect(ask(probe, f, { agentId: 'nope', offset: 0 }).found).toBe(false);
    expect(ask(probe, f, { agentId: '../a1', offset: 0 })).toMatchObject({ error: 'remote-read-failed' });
    expect(ask(probe, f, { agentId: 'a1', offset: 5000 })).toMatchObject({ found: true, reset: true, offset: Buffer.byteLength(line(1)) });
  });
});

describe('resident reader: slim listing lines', () => {
  const SECRET = 'SYNTHETIC-SECRET-CONTENT';
  const rec = (o: object) => JSON.stringify(o) + '\n';
  const raw = [
    '{"type":"fork-context-ref","timestamp":"2026-01-01T11:00:00Z"}\n',
    'not json at all\n',
    '[1,2,3]\n',
    rec({ type: 'user', timestamp: '2026-01-01T11:59:59Z', message: { role: 'user', content: '   ' } }),
    rec({ type: 'user', timestamp: '2026-01-01T12:00:00Z', message: { role: 'user', content: `Count the synthetic widgets ${'z'.repeat(500)}${SECRET}` } }),
    // Only the first plain user line is the task; later ones keep their shape but not their text.
    rec({ type: 'user', timestamp: '2026-01-01T12:00:01Z', message: { role: 'user', content: [{ type: 'text', text: `later user text ${SECRET}` }, { type: 'image', source: { data: SECRET } }] } }),
    rec({ type: 'user', timestamp: '2026-01-01T12:00:01Z', message: { role: 'user', content: `another user string ${SECRET}` } }),
    rec({ type: 'user', timestamp: '2026-01-01T12:00:01Z', message: { role: 'user', content: [{ type: 'text', text: `text beside a result ${SECRET}` }, { type: 'tool_result', tool_use_id: 't9', content: SECRET }] } }),
    rec({ type: 'assistant', timestamp: '2026-01-01T12:00:02Z', effort: 'high', requestId: 'req-1', uuid: 'u-1', isSidechain: true, agentId: 'a1', sessionId: 's',
      message: { id: 'msg-1', model: 'claude-test-model', role: 'assistant', content: [
        { type: 'text', text: SECRET },
        { type: 'thinking', thinking: SECRET },
        { type: 'tool_use', id: 'toolu-bash', name: 'Bash', input: { command: SECRET } },
        { type: 'tool_use', id: 'toolu-spawn', name: 'Agent', input: { prompt: SECRET } },
        { type: 'tool_use', id: 'toolu-task', name: 'Task', input: { prompt: SECRET } },
      ], usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 11, cache_creation_input_tokens: 13, server_tool_use: { web: SECRET }, cache_creation: { ephemeral_5m_input_tokens: 13 } } } }),
    // Same response split across lines: same id, later line carries the larger usage.
    rec({ type: 'assistant', timestamp: '2026-01-01T12:00:03Z', message: { id: 'msg-1', model: '<synthetic>', content: [], usage: { input_tokens: 5, output_tokens: 9 } } }),
    rec({ type: 'user', timestamp: '2026-01-01T12:00:04Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu-bash', content: SECRET, is_error: false }] } }),
    // No message id: falls back to requestId, then uuid.
    rec({ type: 'assistant', timestamp: '2026-01-01T12:00:05Z', requestId: 'req-2', message: { model: 'claude-other', content: [], usage: { output_tokens: 3 } } }),
    rec({ type: 'assistant', timestamp: '2026-01-01T12:00:06Z', uuid: 'u-3', message: { content: 'plain', usage: { output_tokens: 4, input_tokens: -2 } } }),
    rec({ type: 'assistant', timestamp: '2026-01-01T12:00:07Z' }),
    rec({ type: 'system', timestamp: '2026-01-01T12:00:08Z', content: SECRET }),
    rec({ type: 'attachment', timestamp: 'not a date', attachment: SECRET }),
    rec({ type: 'assistant', timestamp: '2026-01-01T11:59:00Z', message: { id: 'msg-early', usage: {} } }),
  ];

  function slimOf(lines: string[]) {
    const f = setup();
    f.append('a1', lines.join(''));
    return text(agent(residentProbe().ask<RemoteSubagentListReply>(f.request()), 'a1'));
  }
  const scanOf = (t: string) => { const scan = createSubagentScan(); foldSubagentLines(scan, t); return scan; };

  it('gives the summary parser exactly what it would have got from the full lines', () => {
    const slim = slimOf(raw);
    const a = scanOf(raw.join(''));
    const b = scanOf(slim);
    expect(b).toEqual(a);
    // Guard against the comparison being vacuous.
    expect(b.firstPrompt).toContain('Count the synthetic widgets');
    expect(b.firstPrompt).not.toContain('later');
    expect([...b.spawnToolIds].sort()).toEqual(['toolu-spawn', 'toolu-task']);
    expect(b.model).toBe('claude-other');
    expect(b.effort).toBe('high');
    expect(b.startedAt).toBe('2026-01-01T11:59:00Z');
    expect(b.lastActivityAt).toBe('2026-01-01T12:00:08Z');
    expect([...b.usage.keys()].sort()).toEqual(['msg-1', 'msg-early', 'req-2', 'u-3']);
    expect(b.usage.get('msg-1')).toEqual({ input: 5, output: 9, cacheRead: 11, cacheWrite: 13 });
  });

  it('drops message content, tool inputs and results, and fields the parser never reads', () => {
    const slim = slimOf(raw);
    expect(slim).not.toContain(SECRET);
    for (const dropped of ['thinking', 'Bash', 'is_error', 'tool_use_id', 'isSidechain', 'agentId', 'server_tool_use', 'cache_creation"', 'image', 'role']) {
      expect(slim).not.toContain(dropped);
    }
    // Only the spawn calls keep a tool_use block, and only name and id.
    const blocks = slim.split('\n').filter(Boolean).flatMap(l => JSON.parse(l).message?.content ?? [])
      .filter((b: unknown) => typeof b === 'object' && (b as { type?: string }).type === 'tool_use');
    expect(blocks).toEqual([{ type: 'tool_use', name: 'Agent', id: 'toolu-spawn' }, { type: 'tool_use', name: 'Task', id: 'toolu-task' }]);
  });

  it('sends no prompt text at all once the caller holds the prompt, and starts again after a reset', () => {
    const f = setup();
    f.append('a1', raw.join(''));
    const probe = residentProbe();
    const held = { a1: { offset: 0, metaMtimeMs: 0, prompt: true } };
    expect(text(agent(probe.ask<RemoteSubagentListReply>(f.request({ known: held })), 'a1'))).not.toContain('Count the synthetic widgets');
    const first = text(agent(probe.ask<RemoteSubagentListReply>(f.request({ known: { a1: { offset: 0, metaMtimeMs: 0 } } })), 'a1'));
    expect(first).toContain('Count the synthetic widgets');
    // A file shorter than the held offset starts over, so its prompt is wanted again.
    const reset = text(agent(probe.ask<RemoteSubagentListReply>(f.request({ known: { a1: { offset: 99_999_999, metaMtimeMs: 0, prompt: true } } })), 'a1'));
    expect(reset).toContain('Count the synthetic widgets');
  });

  it('carries the prompt once across capped responses, not on every chunk', () => {
    const f = setup();
    const user = (n: number) => JSON.stringify({ type: 'user', timestamp: '2026-01-01T12:00:00Z', message: { role: 'user', content: `prompt-${n} ` + 'x'.repeat(300) } }) + '\n';
    f.append('a1', Array.from({ length: 20_000 }, (_, i) => user(i)).join(''));
    const probe = residentProbe();
    let known: Record<string, { offset: number; metaMtimeMs: number; prompt?: boolean }> = {};
    let seen = '';
    for (let round = 0; round < 50; round++) {
      const reply = probe.ask<RemoteSubagentListReply>(f.request({ known }));
      const a = agent(reply, 'a1');
      seen += a.text;
      // Mirror the client: a prompt is held once any text has arrived.
      known = { a1: { offset: a.offset, metaMtimeMs: a.metaMtimeMs, prompt: seen.includes('prompt-') } };
      if (!reply.more) break;
    }
    expect(seen.match(/prompt-\d+/g)).toEqual(['prompt-0']);
  });

  it('is much smaller than the transcript it summarizes', () => {
    const big = Array.from({ length: 200 }, (_, i) => rec({
      type: 'user', timestamp: '2026-01-01T12:00:00Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'x'.repeat(20_000) }] },
    }));
    const slim = slimOf(big);
    expect(Buffer.byteLength(big.join(''))).toBeGreaterThan(4_000_000);
    expect(slim.length).toBeLessThan(200 * 120);
  });

  it('truncates a prompt to what the parser keeps and bounds odd values', () => {
    const slim = slimOf([
      rec({ type: 'user', timestamp: '2026-01-01T12:00:00Z', message: { content: 'q'.repeat(50_000) } }),
      rec({ type: 'assistant', timestamp: '2026-01-01T12:00:01Z', effort: 'e'.repeat(500), message: { id: 'i'.repeat(500), model: 'm'.repeat(500), content: [] } }),
    ]);
    expect(slim.length).toBeLessThan(1000);
    const scan = scanOf(slim);
    expect(scan.firstPrompt).toBe('q'.repeat(400));
    expect(scan.model).toBe('m'.repeat(100));
  });
});
