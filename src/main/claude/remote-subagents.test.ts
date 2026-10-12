import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logger', () => ({ createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn() }) }));

import { RemoteSubagentReader, type RemoteSubagentCaller } from './remote-subagents';
import { buildChildAgentList, type SubagentSnapshot } from './subagents';
import { residentProbe, subagentFixture, SESSION_ID, type SubagentFixture } from '../usage/remote-probe.test-helper';
import { validateSubagentReply, type RemoteProbeTarget, type RemoteSubagentRequest, type RemoteSubagentReply } from '../usage/remote-protocol';

const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, n)).toISOString();
const row = (o: object) => JSON.stringify(o) + '\n';
const prompt = (n: number, text: string) => row({ type: 'user', timestamp: at(n), message: { role: 'user', content: text } });
const answer = (n: number, id: string, output: number, pad = 0) => row({
  type: 'assistant', timestamp: at(n),
  message: { id, role: 'assistant', model: 'claude-test-model', content: [{ type: 'text', text: 'x'.repeat(pad) || 'ok' }], usage: { input_tokens: 1, output_tokens: output } },
});

const fixtures: SubagentFixture[] = [];
afterEach(() => { while (fixtures.length) fixtures.pop()!.cleanup(); vi.useRealTimers(); });

interface Rig {
  f: SubagentFixture;
  reader: RemoteSubagentReader;
  requests: RemoteSubagentRequest[];
  release: ReturnType<typeof vi.fn>;
  open: ReturnType<typeof vi.fn>;
  /** Alters replies in flight, to stand in for a skewed remote clock. */
  tamper: { reply?: (r: RemoteSubagentReply) => RemoteSubagentReply };
  /** Makes the next request fail the way a dropped connection would. */
  failNext(): void;
}

function rig(now: () => number = Date.now): Rig {
  const f = subagentFixture();
  fixtures.push(f);
  const probe = residentProbe();
  const requests: RemoteSubagentRequest[] = [];
  const release = vi.fn();
  const tamper: Rig['tamper'] = {};
  let failing = false;
  const channel: RemoteSubagentCaller = {
    // Real probe, real validation: only the transport is absent.
    call: async request => {
      requests.push(JSON.parse(JSON.stringify(request)));
      if (failing) { failing = false; throw new Error('Remote usage reader unavailable'); }
      const reply = validateSubagentReply(probe.ask({ ...f.request(), ...request, claudeHome: f.home }));
      return tamper.reply ? tamper.reply(reply) : reply;
    },
    release,
  };
  const open = vi.fn(() => channel);
  const target: RemoteProbeTarget = { environmentId: 'env', workspace: '', workingDir: '/synthetic/work', claudeHome: f.home };
  return { f, reader: new RemoteSubagentReader({ target, sessionId: SESSION_ID }, open, now), requests, release, open, tamper, failNext: () => { failing = true; } };
}

const only = (snapshots: SubagentSnapshot[], id = 'a1') => snapshots.find(s => s.id === id)!;
const tokens = (s: SubagentSnapshot) => {
  const list = buildChildAgentList([s], () => false);
  return list.agents[0].tokens;
};

describe('RemoteSubagentReader offsets', () => {
  it('asks once per refresh, continues from the held offset and counts each response once', async () => {
    const { f, reader, requests } = rig();
    f.append('a1', prompt(1, 'synthetic task') + answer(2, 'm1', 10));
    f.meta('a1', { agentType: 'tester', description: 'Synthetic job' });
    const first = await reader.refresh();
    expect(tokens(only(first.snapshots))).toMatchObject({ input: 1, output: 10 });
    expect(only(first.snapshots).meta).toMatchObject({ agentType: 'tester' });

    f.append('a1', answer(3, 'm2', 5));
    const second = await reader.refresh();
    expect(tokens(only(second.snapshots))).toMatchObject({ input: 2, output: 15 });
    // Nothing new: nothing re-read, nothing double counted.
    const third = await reader.refresh();
    expect(tokens(only(third.snapshots))).toMatchObject({ input: 2, output: 15 });

    expect(requests).toHaveLength(3);
    expect(requests[0].known).toEqual({});
    expect(requests[1].known!.a1.offset).toBe(Buffer.byteLength(prompt(1, 'synthetic task') + answer(2, 'm1', 10)));
    expect(requests[2].known!.a1.offset).toBe(Buffer.byteLength(prompt(1, 'synthetic task') + answer(2, 'm1', 10) + answer(3, 'm2', 5)));
    // The project folder is remembered so later requests need no search.
    expect(requests[0].project).toBeUndefined();
    expect(requests[1].project).toBe(f.project);
    // Meta is only re-sent when it changed.
    expect(requests[2].known!.a1.metaMtimeMs).toBeGreaterThan(0);
  });

  it('keeps a partial trailing line out of the totals until the rest of it lands', async () => {
    const { f, reader } = rig();
    const whole = answer(3, 'm2', 7);
    f.append('a1', prompt(1, 'task') + answer(2, 'm1', 3) + whole.slice(0, 40));
    const first = await reader.refresh();
    expect(tokens(only(first.snapshots))).toMatchObject({ output: 3 });
    f.append('a1', whole.slice(40));
    const second = await reader.refresh();
    expect(tokens(only(second.snapshots))).toMatchObject({ output: 10 });
    expect(only(second.snapshots).scan.lastActivityAt).toBe(at(3));
  });

  it('drains a large transcript across capped responses, flagging a backlog until it is all in', async () => {
    const { f, reader } = rig();
    for (const id of ['a1', 'a2', 'a3']) {
      f.append(id, prompt(1, 'task') + Array.from({ length: 3000 }, (_, i) => answer(2 + (i % 50), `${id}-m${i}`, 2, 1200)).join(''));
    }
    let rounds = 0;
    let last = await reader.refresh();
    while (reader.backlog) {
      expect(++rounds).toBeLessThan(25);
      last = await reader.refresh();
    }
    expect(rounds).toBeGreaterThan(1);
    for (const id of ['a1', 'a2', 'a3']) expect(tokens(only(last.snapshots, id))).toMatchObject({ input: 3000, output: 6000 });
  });

  it('starts that agent over when its file shrinks, instead of adding to stale totals', async () => {
    const { f, reader } = rig();
    f.append('a1', prompt(1, 'task') + answer(2, 'm1', 50) + answer(3, 'm2', 50));
    await reader.refresh();
    fs.writeFileSync(path.join(f.dir, 'agent-a1.jsonl'), prompt(1, 'task') + answer(2, 'n1', 4));
    const next = await reader.refresh();
    expect(tokens(only(next.snapshots))).toMatchObject({ output: 4 });
  });

  it('drops agents that left the folder and forgets everything when the folder goes', async () => {
    const { f, reader } = rig();
    f.append('a1', prompt(1, 'a')); f.append('a2', prompt(1, 'b'));
    expect((await reader.refresh()).snapshots.map(s => s.id).sort()).toEqual(['a1', 'a2']);
    fs.rmSync(path.join(f.dir, 'agent-a2.jsonl'));
    expect((await reader.refresh()).snapshots.map(s => s.id)).toEqual(['a1']);
    fs.rmSync(f.dir, { recursive: true });
    expect(await reader.refresh()).toEqual({ snapshots: [], total: 0 });
  });

  it('reports files on the local clock even when the remote clock is an hour ahead', async () => {
    const t0 = Date.now();
    const { f, reader, tamper } = rig(() => t0);
    f.append('a1', prompt(1, 'task'));
    const mtime = new Date(t0 - 10_000);
    fs.utimesSync(path.join(f.dir, 'agent-a1.jsonl'), mtime, mtime);
    const HOUR = 3_600_000;
    tamper.reply = r => r.op === 'subagents'
      ? { ...r, now: r.now + HOUR, agents: r.agents.map(a => ({ ...a, mtimeMs: a.mtimeMs + HOUR, birthMs: a.birthMs + HOUR })) }
      : r;
    const snapshot = only((await reader.refresh()).snapshots);
    // Ten seconds old by the remote's own clock, so inside the 30s "running" window here too.
    expect(t0 - snapshot.mtimeMs).toBeGreaterThanOrEqual(9_000);
    expect(t0 - snapshot.mtimeMs).toBeLessThan(11_000);
  });

  it('shows nothing and holds no state when the session has no subagent folder', async () => {
    const { f, reader } = rig();
    fs.rmSync(f.dir, { recursive: true });
    expect(await reader.refresh()).toEqual({ snapshots: [], total: 0 });
    expect(reader.backlog).toBe(false);
  });

  it('ignores a reply that arrives after close and releases its channel once', async () => {
    const { f, reader, release } = rig();
    f.append('a1', prompt(1, 'task'));
    const pending = reader.refresh();
    reader.close();
    reader.close();
    expect(await pending).toEqual({ snapshots: [], total: 0 });
    expect(release).toHaveBeenCalledOnce();
  });
});

describe('RemoteSubagentReader hold on the host reader', () => {
  it('takes the hold on first use and keeps it across idle gaps while the session is alive', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { f, reader, open, release } = rig();
    f.append('a1', prompt(1, 'task'));
    expect(open).not.toHaveBeenCalled();
    await reader.refresh();
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
    await reader.refresh();
    expect(open).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
  });

  it('lets go when the session ends, and holds only for the call when a viewer reads a finished session', async () => {
    const { f, reader, open, release } = rig();
    f.append('a1', prompt(1, 'task') + answer(2, 'm1', 3));
    reader.setAlive(true);
    await reader.refresh();
    reader.setAlive(false);
    expect(release).toHaveBeenCalledOnce();

    expect((await reader.transcript('a1'))!.prompt).toBe('task');
    expect(open).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);

    reader.setAlive(true);
    await reader.refresh();
    expect(release).toHaveBeenCalledTimes(2);
    reader.close();
    expect(release).toHaveBeenCalledTimes(3);
  });

  it('never releases a hold while a request is still in flight', async () => {
    const { f, reader, release } = rig();
    f.append('a1', prompt(1, 'task'));
    const pending = reader.refresh();
    reader.setAlive(false);
    expect(release).not.toHaveBeenCalled();
    await pending;
    expect(release).toHaveBeenCalledOnce();
  });
});

describe('RemoteSubagentReader transcript', () => {
  const finished = (n: number, text: string) => row({
    type: 'assistant', timestamp: at(n),
    message: { id: `m${n}`, role: 'assistant', model: 'claude-test-model', content: [{ type: 'text', text }], usage: { output_tokens: 1 } },
  });

  it('digests the file and then fetches only what was appended', async () => {
    const { f, reader, requests } = rig();
    const head = prompt(1, 'Count widgets') + finished(2, 'Working on it');
    f.append('a1', head);
    const first = await reader.transcript('a1');
    expect(first).toMatchObject({ prompt: 'Count widgets', truncated: false });
    expect(first!.result).toBe('Working on it');

    f.append('a1', finished(3, 'Three.'));
    const second = await reader.transcript('a1');
    expect(second!.result).toBe('Three.');
    expect(second!.entries.map(e => e.kind === 'text' && e.text)).toEqual(['Working on it']);
    const asked = requests.filter(r => r.op === 'subagent-transcript');
    expect(asked.map(r => r.offset)).toEqual([0, Buffer.byteLength(head)]);
    // Nothing changed: one empty request, nothing folded twice.
    const third = await reader.transcript('a1');
    expect(third!.entries).toHaveLength(1);
  });

  it('keeps the task and the latest work of a transcript too long to read whole, without fetching the middle', async () => {
    const { f, reader, requests } = rig();
    const MiB = 1024 * 1024;
    const first = prompt(1, 'Synthetic long task');
    const filler = (i: number) => finished(2, `filler-${i} ${'x'.repeat(4000)}`);
    const fillerCount = Math.ceil((12 * MiB) / filler(0).length);
    const last = finished(5, 'The final answer');
    fs.writeFileSync(path.join(f.dir, 'agent-a1.jsonl'), first + Array.from({ length: fillerCount }, (_, i) => filler(i)).join('') + last);
    const size = fs.statSync(path.join(f.dir, 'agent-a1.jsonl')).size;

    const result = await reader.transcript('a1');
    expect(result!.prompt).toBe('Synthetic long task');
    expect(result!.result).toBe('The final answer');
    expect(result!.truncated).toBe(true);
    // The first fragment of the tail window is dropped, not parsed as a record.
    expect(result!.entries.length).toBeGreaterThan(100);

    const offsets = requests.filter(r => r.op === 'subagent-transcript').map(r => r.offset!);
    expect(offsets[0]).toBe(0);
    expect(offsets[1]).toBe(size - 8 * MiB);
    // Head chunk plus the 8 MiB tail, never the ~4 MiB in between.
    expect(offsets.length).toBeLessThanOrEqual(12);
    expect(offsets.slice(2).every(o => o > size - 8 * MiB)).toBe(true);
  });

  it('returns what it has when a long file needs more rounds, and the next refresh continues', async () => {
    const { f, reader, requests } = rig();
    const record = answer(2, 'm', 1, 3500);
    fs.writeFileSync(path.join(f.dir, 'agent-a1.jsonl'), prompt(1, 'task') + record.repeat(Math.ceil((30 * 1024 * 1024) / record.length)));
    await reader.transcript('a1');
    const afterFirst = requests.length;
    expect(afterFirst).toBeLessThanOrEqual(12);
    await reader.transcript('a1');
    expect(requests.length).toBeGreaterThan(afterFirst);
  });

  it('starts over when a viewer is released, and returns null for a missing or unsafe agent', async () => {
    const { f, reader, requests } = rig();
    f.append('a1', prompt(1, 'task'));
    await reader.transcript('a1');
    reader.releaseTranscript('a1');
    await reader.transcript('a1');
    expect(requests.filter(r => r.op === 'subagent-transcript').map(r => r.offset)).toEqual([0, 0]);
    expect(await reader.transcript('missing')).toBeNull();
    const before = requests.length;
    expect(await reader.transcript('../a1')).toBeNull();
    expect(requests).toHaveLength(before);
  });

  it('starts over when the remote file was replaced by a shorter one', async () => {
    const { f, reader } = rig();
    f.append('a1', prompt(1, 'a long first task description') + finished(2, 'old'));
    await reader.transcript('a1');
    fs.writeFileSync(path.join(f.dir, 'agent-a1.jsonl'), prompt(1, 'new'));
    const next = await reader.transcript('a1');
    expect(next).toMatchObject({ prompt: 'new', entries: [], result: null });
  });

  it('leaves its offset and digest alone when a request fails, so a retry folds each line once', async () => {
    const { f, reader, failNext } = rig();
    f.append('a1', prompt(1, 'task') + finished(2, 'one'));
    await reader.transcript('a1');
    f.append('a1', finished(3, 'two'));
    failNext();
    await expect(reader.transcript('a1')).rejects.toThrow();
    const retry = await reader.transcript('a1');
    expect(retry!.entries.map(e => e.kind === 'text' && e.text)).toEqual(['one']);
    expect(retry!.result).toBe('two');
  });
});

describe('RemoteSubagentReader folder lookup', () => {
  it('stops searching all projects after misses, backing off like the local scan, and starts again on a hook event', async () => {
    let t = 1_000_000;
    const { f, reader, requests } = rig(() => t);
    fs.rmSync(f.dir, { recursive: true });
    const scans = () => requests.map(r => r.scan !== false);

    await reader.refresh();              // miss: backs off 2.5s
    await reader.refresh();              // inside the window: no search
    t += 2_600;
    await reader.refresh();              // search again, miss: backs off 5s
    t += 2_600;
    await reader.refresh();              // still inside 5s
    expect(scans()).toEqual([true, false, true, false]);

    reader.resetLookup();
    await reader.refresh();
    expect(scans().at(-1)).toBe(true);

    // Finding the folder clears the backoff.
    fs.mkdirSync(f.dir, { recursive: true });
    f.append('a1', prompt(1, 'task'));
    t += 100_000;
    expect((await reader.refresh()).snapshots).toHaveLength(1);
    await reader.refresh();
    expect(scans().at(-1)).toBe(true);
  });
});
