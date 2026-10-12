import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-subagent-home-'));
vi.mock('electron', () => ({
  app: { getPath: (key: string) => (key === 'home' ? fakeHome : '') },
}));

import {
  SubagentDirReader,
  buildChildAgentList,
  createSubagentScan,
  findSubagentsDir,
  foldSubagentLines,
  parseSubagentMeta,
  parseSubagentTranscript,
  SubagentTranscriptReader,
  createTranscriptState,
  finishTranscript,
  foldTranscriptLines,
  TRANSCRIPT_HEAD_BYTES,
  TRANSCRIPT_TAIL_BYTES,
  findSubagentsDirByScan,
  findSubagentsDirDirect,
  subagentTranscriptPath,
  scanTokens,
  summarizeToolInput,
  toChildAgentInfo,
  type SubagentSnapshot,
} from './subagents';

const SESSION = '11111111-2222-4333-8444-555555555555';

// Synthetic records shaped like Claude Code's transcript lines. No real content.
const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, n)).toISOString();
const line = (o: object) => JSON.stringify(o) + '\n';
const user = (n: number, content: unknown) => line({
  type: 'user', isSidechain: true, agentId: 'a1', sessionId: SESSION, uuid: `u${n}`, timestamp: at(n),
  message: { role: 'user', content },
});
const assistant = (n: number, opts: {
  id: string; model?: string; effort?: string; blocks: unknown[];
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}) => line({
  type: 'assistant', isSidechain: true, agentId: 'a1', sessionId: SESSION, uuid: `a${n}`, timestamp: at(n),
  requestId: `req-${opts.id}`, ...(opts.effort ? { effort: opts.effort } : {}),
  message: { id: opts.id, role: 'assistant', model: opts.model ?? 'claude-test-model', content: opts.blocks, usage: opts.usage },
});

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-subagents-'));
  tmpDirs.push(dir);
  return dir;
}

beforeEach(() => { delete process.env.CLAUDE_CONFIG_DIR; });
afterEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});


/** Make the nth read (1-based, across all files opened while active) reject once. */
function failNthRead(n: number) {
  let reads = 0;
  const realOpen = fs.promises.open.bind(fs.promises);
  const spy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
    const handle = await realOpen(...args);
    const realRead = handle.read.bind(handle);
    (handle as unknown as { read: unknown }).read = (async (...a: unknown[]) => {
      if (++reads === n) throw new Error('injected read failure');
      return (realRead as (...x: unknown[]) => unknown)(...a);
    });
    return handle;
  });
  return () => spy.mockRestore();
}
const bigToolLine = (i: number) => assistant(i, { id: `big${i}`, blocks: [{ type: 'tool_use', id: `bt${i}`, name: 'Bash', input: { command: 'y'.repeat(700_000) } }], usage: { output_tokens: 10 } });

describe('parseSubagentMeta', () => {
  it('reads the fields it knows and ignores the rest', () => {
    const meta = parseSubagentMeta(JSON.stringify({
      agentType: 'tester', description: 'Check things', toolUseId: 'toolu_1', spawnDepth: 2,
      requestShape: 'background', model: 'sonnet', effort: 'medium', parentAgentId: 'abc123', somethingNew: { x: 1 },
    }));
    expect(meta).toEqual({
      agentType: 'tester', description: 'Check things', toolUseId: 'toolu_1', spawnDepth: 2,
      requestShape: 'background', model: 'sonnet', effort: 'medium', parentAgentId: 'abc123',
    });
  });

  it('rejects non-objects and drops wrongly typed or unsafe fields', () => {
    expect(parseSubagentMeta('not json')).toBeNull();
    expect(parseSubagentMeta('[1]')).toBeNull();
    expect(parseSubagentMeta('"x"')).toBeNull();
    const meta = parseSubagentMeta(JSON.stringify({ agentType: 7, spawnDepth: 'deep', parentAgentId: '../evil', model: '  ' }));
    expect(meta).toMatchObject({ agentType: undefined, spawnDepth: undefined, parentAgentId: undefined, model: undefined });
  });
});

describe('foldSubagentLines', () => {
  it('sums usage once per API response even when its content blocks span several lines', () => {
    const scan = createSubagentScan();
    const usage = { input_tokens: 3, output_tokens: 40, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 };
    foldSubagentLines(scan, [
      user(1, 'do the task'),
      assistant(2, { id: 'msg_1', blocks: [{ type: 'text', text: 'thinking aloud' }], usage }),
      assistant(3, { id: 'msg_1', blocks: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }], usage }),
      assistant(4, { id: 'msg_2', blocks: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1, output_tokens: 10 } }),
    ].join(''));
    expect(scanTokens(scan)).toEqual({ input: 4, output: 50, cacheRead: 1000, cacheWrite: 200 });
  });

  it('keeps the largest figure when a response repeats usage with a partial count first', () => {
    const scan = createSubagentScan();
    foldSubagentLines(scan, [
      assistant(1, { id: 'msg_1', blocks: [{ type: 'text', text: 'a' }], usage: { output_tokens: 5 } }),
      assistant(2, { id: 'msg_1', blocks: [{ type: 'text', text: 'b' }], usage: { output_tokens: 25 } }),
    ].join(''));
    expect(scanTokens(scan).output).toBe(25);
  });

  it('takes the resolved model and effort from the last assistant line and skips synthetic ones', () => {
    const scan = createSubagentScan();
    foldSubagentLines(scan, [
      assistant(1, { id: 'm1', model: 'claude-first', effort: 'low', blocks: [] }),
      assistant(2, { id: 'm2', model: 'claude-second', effort: 'high', blocks: [] }),
      assistant(3, { id: 'm3', model: '<synthetic>', blocks: [] }),
    ].join(''));
    expect(scan.model).toBe('claude-second');
    expect(scan.effort).toBe('high');
  });

  it('skips malformed lines, blank lines and unknown record types without losing the rest', () => {
    const scan = createSubagentScan();
    foldSubagentLines(scan, [
      'not json at all\n',
      '\n',
      '{"type":"assistant","message":\n',
      '[1,2,3]\n',
      line({ type: 'fork-context-ref', agentId: 'a1', parentSessionId: SESSION }),
      line({ type: 'mystery', timestamp: at(1) }),
      user(2, [{ type: 'text', text: 'the real task' }]),
      assistant(3, { id: 'm1', blocks: [], usage: { output_tokens: 7 } }),
    ].join(''));
    expect(scan.firstPrompt).toBe('the real task');
    expect(scanTokens(scan).output).toBe(7);
    expect(scan.startedAt).toBe(at(1));
    expect(scan.lastActivityAt).toBe(at(3));
  });

  it('ignores tool results when looking for the task prompt', () => {
    const scan = createSubagentScan();
    foldSubagentLines(scan, user(1, [{ type: 'tool_result', tool_use_id: 't', content: 'output' }]));
    expect(scan.firstPrompt).toBeUndefined();
  });

  it('records the ids of the Agent and Task calls a child made', () => {
    const scan = createSubagentScan();
    foldSubagentLines(scan, assistant(1, { id: 'm1', blocks: [
      { type: 'tool_use', id: 'toolu_spawn', name: 'Agent', input: {} },
      { type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: {} },
    ] }));
    expect([...scan.spawnToolIds]).toEqual(['toolu_spawn']);
  });
});

describe('toChildAgentInfo', () => {
  const snapshot = (over: Partial<SubagentSnapshot> = {}): SubagentSnapshot => {
    const scan = createSubagentScan();
    foldSubagentLines(scan, [user(1, 'Investigate the thing\nmore detail'), assistant(5, { id: 'm1', model: 'claude-resolved', effort: 'high', blocks: [], usage: { output_tokens: 9 } })].join(''));
    return { id: 'a1', meta: null, scan, mtimeMs: Date.UTC(2026, 0, 1, 12, 0, 5), birthMs: 0, ...over };
  };

  it('distinguishes the requested model from the one that answered', () => {
    const info = toChildAgentInfo(snapshot({ meta: { agentType: 'tester', description: 'd', model: 'sonnet', effort: 'medium', requestShape: 'background', spawnDepth: 2, toolUseId: 'toolu_9' } }), true);
    expect(info).toMatchObject({
      source: 'claude-subagent', id: 'a1', agentType: 'tester', description: 'd', requestedModel: 'sonnet',
      model: 'claude-resolved', effort: 'high', background: true, depth: 2, parentToolUseId: 'toolu_9', state: 'running',
      startedAt: at(1), lastActivityAt: at(5),
    });
    expect(info.tokens.output).toBe(9);
  });

  it('falls back to the requested effort, and omits what was never requested', () => {
    const scan = createSubagentScan();
    foldSubagentLines(scan, assistant(1, { id: 'm', blocks: [] }));
    const info = toChildAgentInfo({ id: 'a1', meta: { effort: 'low' }, scan, mtimeMs: 0, birthMs: 0 }, false);
    expect(info.effort).toBe('low');
    expect(info).not.toHaveProperty('requestedModel');
    expect(info.state).toBe('done');
  });

  it('derives what it can from the transcript when there is no meta file', () => {
    const info = toChildAgentInfo(snapshot(), false);
    expect(info).toMatchObject({ agentType: 'subagent', description: 'Investigate the thing', depth: 1, background: false });
  });

  it('uses file times when the transcript has no timestamps', () => {
    const info = toChildAgentInfo({ id: 'a1', meta: null, scan: createSubagentScan(), mtimeMs: Date.UTC(2026, 1, 1), birthMs: Date.UTC(2026, 0, 1) }, false);
    expect(info.startedAt).toBe(new Date(Date.UTC(2026, 0, 1)).toISOString());
    expect(info.lastActivityAt).toBe(new Date(Date.UTC(2026, 1, 1)).toISOString());
  });
});

describe('buildChildAgentList nesting', () => {
  const snap = (id: string, startSec: number, meta: SubagentSnapshot['meta'], spawns: string[] = []): SubagentSnapshot => {
    const scan = createSubagentScan();
    scan.startedAt = at(startSec);
    scan.lastActivityAt = at(startSec + 1);
    spawns.forEach(s => scan.spawnToolIds.add(s));
    return { id, meta, scan, mtimeMs: 0, birthMs: 0 };
  };

  it('places each child under its parent using parentAgentId, else the spawning tool call', () => {
    const list = buildChildAgentList([
      snap('late', 30, { spawnDepth: 1 }, ['toolu_late']),
      snap('grandchild', 12, { spawnDepth: 3, parentAgentId: 'child' }),
      snap('child', 10, { spawnDepth: 2, toolUseId: 'toolu_root' }),
      snap('root', 1, { spawnDepth: 1 }, ['toolu_root']),
      snap('viaTool', 20, { spawnDepth: 2, toolUseId: 'toolu_late' }),
    ], () => false);
    expect(list.agents.map(a => `${a.id}:${a.depth}`)).toEqual(['root:1', 'child:2', 'grandchild:3', 'late:1', 'viaTool:2']);
    expect(list.agents.find(a => a.id === 'child')?.parentId).toBe('root');
    expect(list.agents.find(a => a.id === 'grandchild')?.parentId).toBe('child');
    expect(list.agents.find(a => a.id === 'viaTool')?.parentId).toBe('late');
  });

  it('lists an orphan whose parent is not on disk as a top-level row at its own depth', () => {
    const list = buildChildAgentList([snap('orphan', 5, { spawnDepth: 2, parentAgentId: 'gone' })], () => false, 7);
    expect(list.agents[0]).toMatchObject({ id: 'orphan', depth: 2 });
    expect(list.agents[0].parentId).toBeUndefined();
    expect(list.total).toBe(7);
  });

  it('survives a spawn cycle in corrupt data', () => {
    const list = buildChildAgentList([
      snap('a', 1, { parentAgentId: 'b' }),
      snap('b', 2, { parentAgentId: 'a' }),
    ], () => false);
    expect(list.agents.map(a => a.id).sort()).toEqual(['a', 'b']);
  });

  it('asks the caller whether each agent is running', () => {
    const list = buildChildAgentList([snap('x', 1, null), snap('y', 2, null)], id => id === 'y');
    expect(list.agents.map(a => a.state)).toEqual(['done', 'running']);
  });
});

describe('parseSubagentTranscript', () => {
  it('returns the task, the tool calls and text in order, and the closing answer separately', () => {
    const parsed = parseSubagentTranscript([
      user(1, 'Count the widgets'),
      assistant(2, { id: 'm1', blocks: [{ type: 'text', text: 'Looking' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls\n  -la' } }] }),
      user(3, [{ type: 'tool_result', tool_use_id: 't1', content: 'secret output', is_error: true }]),
      assistant(4, { id: 'm2', blocks: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/tmp/x' } }] }),
      assistant(5, { id: 'm3', blocks: [{ type: 'text', text: 'There are 3 widgets.' }] }),
    ].join(''));
    expect(parsed.prompt).toBe('Count the widgets');
    expect(parsed.entries).toEqual([
      { kind: 'text', text: 'Looking' },
      { kind: 'tool', name: 'Bash', summary: 'ls -la', failed: true },
      { kind: 'tool', name: 'Read', summary: '/tmp/x' },
    ]);
    expect(parsed.result).toBe('There are 3 widgets.');
    expect(parsed.truncated).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain('secret output');
  });

  it('has no result while the child is still working on a tool call', () => {
    const parsed = parseSubagentTranscript(assistant(1, { id: 'm', blocks: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] }));
    expect(parsed.result).toBeNull();
    expect(parsed.prompt).toBeNull();
  });

  it('keeps only the most recent entries of a very long run', () => {
    const many = Array.from({ length: 1000 }, (_, i) => assistant(i, { id: `m${i}`, blocks: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: `cmd ${i}` } }] })).join('');
    const parsed = parseSubagentTranscript(many);
    expect(parsed.entries.length).toBeLessThanOrEqual(400);
    expect(parsed.truncated).toBe(true);
    expect(parsed.entries.at(-1)).toMatchObject({ summary: 'cmd 999' });
  });

  it('summarises tool input on one bounded line', () => {
    expect(summarizeToolInput({ pattern: 'foo', path: '/x' })).toBe('/x');
    expect(summarizeToolInput({ other: 'first string' })).toBe('first string');
    expect(summarizeToolInput({ n: 1 })).toBe('');
    expect(summarizeToolInput('a\n b')).toBe('a b');
    expect(summarizeToolInput({ command: 'x'.repeat(500) }).length).toBe(160);
  });
});

describe('SubagentDirReader', () => {
  const metaFor = (extra: object = {}) => JSON.stringify({ agentType: 'tester', description: 'Check', toolUseId: 'toolu_1', spawnDepth: 1, requestShape: 'background', ...extra });

  it('reads meta and transcript, and tolerates a missing meta file', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'agent-a1.jsonl'), user(1, 'task one') + assistant(2, { id: 'm1', blocks: [], usage: { output_tokens: 4 } }));
    fs.writeFileSync(path.join(dir, 'agent-a1.meta.json'), metaFor({ model: 'sonnet' }));
    fs.writeFileSync(path.join(dir, 'agent-old.jsonl'), user(1, 'legacy task'));
    fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'x');
    fs.writeFileSync(path.join(dir, 'agent-bad id.jsonl'), 'x');
    const { snapshots, total } = await new SubagentDirReader(dir).refresh();
    expect(total).toBe(2);
    const byId = new Map(snapshots.map(s => [s.id, s]));
    expect(toChildAgentInfo(byId.get('a1')!, false)).toMatchObject({ agentType: 'tester', requestedModel: 'sonnet', model: 'claude-test-model', background: true });
    expect(toChildAgentInfo(byId.get('old')!, false)).toMatchObject({ agentType: 'subagent', description: 'legacy task' });
  });

  it('picks up appended lines without re-reading what it already folded', async () => {
    const dir = tmp();
    const file = path.join(dir, 'agent-a1.jsonl');
    fs.writeFileSync(file, user(1, 'task') + assistant(2, { id: 'm1', blocks: [], usage: { output_tokens: 10 } }));
    const reader = new SubagentDirReader(dir);
    expect(scanTokens((await reader.refresh()).snapshots[0].scan).output).toBe(10);

    fs.appendFileSync(file, assistant(3, { id: 'm2', blocks: [], usage: { output_tokens: 5 } }));
    const next = (await reader.refresh()).snapshots[0];
    expect(scanTokens(next.scan).output).toBe(15);
    expect(next.scan.lastActivityAt).toBe(at(3));
  });

  it('only reads the new bytes on a later refresh', async () => {
    const dir = tmp();
    const file = path.join(dir, 'agent-a1.jsonl');
    const first = user(1, 'task') + assistant(2, { id: 'm1', blocks: [] });
    fs.writeFileSync(file, first);
    const reader = new SubagentDirReader(dir);
    await reader.refresh();
    const appended = assistant(3, { id: 'm2', blocks: [] });
    fs.appendFileSync(file, appended);
    const positions: number[] = [];
    const realOpen = fs.promises.open.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await realOpen(...args);
      const realRead = handle.read.bind(handle);
      (handle as unknown as { read: unknown }).read = (async (...a: unknown[]) => { positions.push(a[3] as number); return (realRead as (...x: unknown[]) => unknown)(...a); });
      return handle;
    });
    await reader.refresh();
    spy.mockRestore();
    expect(positions).toEqual([Buffer.byteLength(first)]);
  });

  it('holds back a partial last line until its newline arrives', async () => {
    const dir = tmp();
    const file = path.join(dir, 'agent-a1.jsonl');
    const complete = assistant(1, { id: 'm1', blocks: [], usage: { output_tokens: 3 } });
    const second = assistant(2, { id: 'm2', blocks: [], usage: { output_tokens: 4 } });
    fs.writeFileSync(file, complete + second.slice(0, 40));
    const reader = new SubagentDirReader(dir);
    expect(scanTokens((await reader.refresh()).snapshots[0].scan).output).toBe(3);
    fs.appendFileSync(file, second.slice(40));
    expect(scanTokens((await reader.refresh()).snapshots[0].scan).output).toBe(7);
  });

  it('does not split a multi-byte character across reads', async () => {
    const dir = tmp();
    const file = path.join(dir, 'agent-a1.jsonl');
    const prompt = '日本語の依頼'.repeat(3);
    const text = user(1, prompt);
    const bytes = Buffer.from(text);
    const cut = bytes.indexOf(Buffer.from('語')) + 1;
    fs.writeFileSync(file, bytes.subarray(0, cut));
    const reader = new SubagentDirReader(dir);
    await reader.refresh();
    fs.appendFileSync(file, bytes.subarray(cut));
    expect((await reader.refresh()).snapshots[0].scan.firstPrompt).toBe(prompt);
  });

  it('starts over when a transcript shrinks', async () => {
    const dir = tmp();
    const file = path.join(dir, 'agent-a1.jsonl');
    fs.writeFileSync(file, user(1, 'long original task text') + assistant(2, { id: 'm1', blocks: [], usage: { output_tokens: 50 } }));
    const reader = new SubagentDirReader(dir);
    await reader.refresh();
    fs.writeFileSync(file, user(1, 'new') + assistant(2, { id: 'n1', blocks: [], usage: { output_tokens: 2 } }));
    const next = (await reader.refresh()).snapshots[0];
    expect(scanTokens(next.scan).output).toBe(2);
    expect(next.scan.firstPrompt).toBe('new');
  });

  it('leaves a transcript untouched when a read fails part-way, then folds it once on retry', async () => {
    const dir = tmp();
    const file = path.join(dir, 'agent-a1.jsonl');
    fs.writeFileSync(file, user(1, 'task') + assistant(2, { id: 'm1', blocks: [], usage: { output_tokens: 3 } }));
    const reader = new SubagentDirReader(dir);
    await reader.refresh();

    fs.appendFileSync(file, bigToolLine(3) + bigToolLine(4) + bigToolLine(5));
    const restore = failNthRead(2);
    let during;
    try { during = (await reader.refresh()).snapshots[0]; } finally { restore(); }
    expect(scanTokens(during.scan).output).toBe(3);
    expect(during.scan.lastActivityAt).toBe(at(2));
    expect(during.scan.spawnToolIds.size).toBe(0);

    const after = (await reader.refresh()).snapshots[0];
    expect(scanTokens(after.scan).output).toBe(33);
    expect(after.scan.lastActivityAt).toBe(at(5));
  });

  it('picks up a meta file written after the transcript', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'agent-a1.jsonl'), user(1, 'task'));
    const reader = new SubagentDirReader(dir);
    expect((await reader.refresh()).snapshots[0].meta).toBeNull();
    fs.writeFileSync(path.join(dir, 'agent-a1.meta.json'), metaFor());
    expect((await reader.refresh()).snapshots[0].meta?.agentType).toBe('tester');
  });

  it('keeps only the newest 50 subagents but reports the real total', async () => {
    const dir = tmp();
    for (let i = 0; i < 55; i++) {
      const file = path.join(dir, `agent-n${i}.jsonl`);
      fs.writeFileSync(file, user(i, `task ${i}`));
      fs.utimesSync(file, new Date(1_700_000_000_000 + i * 1000), new Date(1_700_000_000_000 + i * 1000));
    }
    const { snapshots, total } = await new SubagentDirReader(dir).refresh();
    expect(total).toBe(55);
    expect(snapshots).toHaveLength(50);
    expect(snapshots.map(s => s.id)).not.toContain('n0');
    expect(snapshots.map(s => s.id)).toContain('n54');
  });

  it('returns nothing when the folder is gone', async () => {
    const dir = path.join(tmp(), 'missing');
    expect(await new SubagentDirReader(dir).refresh()).toEqual({ snapshots: [], total: 0 });
  });
});

describe('findSubagentsDir and transcript reads', () => {
  it('prefers the folder derived from the working directory', () => {
    const home = tmp();
    process.env.CLAUDE_CONFIG_DIR = home;
    const cwd = '/work/my.repo';
    const direct = path.join(home, 'projects', '-work-my-repo', SESSION, 'subagents');
    fs.mkdirSync(direct, { recursive: true });
    fs.mkdirSync(path.join(home, 'projects', 'other', SESSION, 'subagents'), { recursive: true });
    expect(findSubagentsDir(SESSION, cwd)).toBe(direct);
  });

  it('falls back to the one project folder holding the session, and refuses two', () => {
    const home = tmp();
    process.env.CLAUDE_CONFIG_DIR = home;
    const hashed = path.join(home, 'projects', 'long-name-hash', SESSION, 'subagents');
    fs.mkdirSync(hashed, { recursive: true });
    expect(findSubagentsDir(SESSION, '/work/elsewhere')).toBe(hashed);
    fs.mkdirSync(path.join(home, 'projects', 'second', SESSION, 'subagents'), { recursive: true });
    expect(findSubagentsDir(SESSION, '/work/elsewhere')).toBeNull();
  });

  it('rejects an id that is not a session uuid and a session with no subagents folder', () => {
    process.env.CLAUDE_CONFIG_DIR = tmp();
    expect(findSubagentsDir('../../etc', '/x')).toBeNull();
    expect(findSubagentsDir(SESSION, '/x')).toBeNull();
  });

  it('splits the lookup into a one-stat direct path and a project scan', () => {
    const home = tmp();
    process.env.CLAUDE_CONFIG_DIR = home;
    const hashed = path.join(home, 'projects', 'long-name-hash', SESSION, 'subagents');
    fs.mkdirSync(hashed, { recursive: true });
    expect(findSubagentsDirDirect(SESSION, '/work/elsewhere')).toBeNull();
    expect(findSubagentsDirByScan(SESSION)).toBe(hashed);
    const direct = path.join(home, 'projects', '-work-elsewhere', SESSION, 'subagents');
    fs.mkdirSync(direct, { recursive: true });
    expect(findSubagentsDirDirect(SESSION, '/work/elsewhere')).toBe(direct);
    expect(findSubagentsDirDirect('../x', '/work/elsewhere')).toBeNull();
  });

  it('refuses agent ids that could leave the folder', () => {
    const dir = tmp();
    expect(subagentTranscriptPath(dir, '../ok')).toBeNull();
    expect(subagentTranscriptPath(dir, 'a/b')).toBeNull();
    expect(subagentTranscriptPath(dir, 'ok')).toBe(path.join(dir, 'agent-ok.jsonl'));
  });
});

describe('SubagentTranscriptReader', () => {
  const toolLine = (i: number) => assistant(i, { id: `m${i}`, blocks: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: `cmd ${i} ${'x'.repeat(900)}` } }] });

  function bigTranscript(file: string) {
    // Larger than the head plus tail windows, so the middle must be skipped.
    const fd = fs.openSync(file, 'w');
    fs.writeSync(fd, user(1, 'The original task'));
    let i = 2;
    let bytes = 0;
    while (bytes < TRANSCRIPT_HEAD_BYTES + TRANSCRIPT_TAIL_BYTES + 2 * 1024 * 1024) {
      const l = toolLine(i++);
      bytes += fs.writeSync(fd, l);
    }
    fs.writeSync(fd, assistant(i, { id: 'final', blocks: [{ type: 'text', text: 'The final answer.' }] }));
    fs.closeSync(fd);
    return i - 1;
  }

  it('shows the task and the newest work of a transcript bigger than the read windows', async () => {
    const dir = tmp();
    const file = path.join(dir, 'agent-big.jsonl');
    const lastTool = bigTranscript(file);
    expect(fs.statSync(file).size).toBeGreaterThan(TRANSCRIPT_HEAD_BYTES + TRANSCRIPT_TAIL_BYTES);
    const reader = new SubagentTranscriptReader();
    reader.attach(file);
    const parsed = (await reader.refresh())!;
    expect(parsed.prompt).toBe('The original task');
    expect(parsed.result).toBe('The final answer.');
    expect(parsed.truncated).toBe(true);
    // 400 kept, one of which is the closing answer reported separately.
    expect(parsed.entries).toHaveLength(399);
    expect(parsed.entries.at(-1)).toMatchObject({ kind: 'tool', summary: expect.stringContaining(`cmd ${lastTool} `) });
  });

  it('does not duplicate entries when a read fails part-way and is retried', async () => {
    const dir = tmp();
    const file = path.join(dir, 'agent-a.jsonl');
    const first = user(1, 'task') + toolLine(2);
    fs.writeFileSync(file, first);
    const reader = new SubagentTranscriptReader();
    reader.attach(file);
    await reader.refresh();

    // ~2.1 MB appended is read in 1 MB pieces; the second piece fails.
    fs.appendFileSync(file, bigToolLine(3) + bigToolLine(4) + bigToolLine(5));
    const restore = failNthRead(2);
    try {
      const during = (await reader.refresh())!;
      expect(during.entries).toHaveLength(1);
    } finally {
      restore();
    }
    const after = (await reader.refresh())!;
    expect(after.entries).toHaveLength(4);
    expect(after.entries.map(e => (e as { summary: string }).summary.slice(0, 5))).toEqual(['cmd 2', 'yyyyy', 'yyyyy', 'yyyyy']);
  });

  it('keeps a small transcript whole and not truncated', async () => {
    const dir = tmp();
    const file = path.join(dir, 'agent-a.jsonl');
    fs.writeFileSync(file, user(1, 'task') + toolLine(2) + assistant(3, { id: 'f', blocks: [{ type: 'text', text: 'done' }] }));
    const reader = new SubagentTranscriptReader();
    reader.attach(file);
    expect(await reader.refresh()).toMatchObject({ prompt: 'task', result: 'done', truncated: false, entries: [{ kind: 'tool' }] });
  });

  it('reads only appended bytes on later refreshes and nothing while the file is unchanged', async () => {
    const dir = tmp();
    const file = path.join(dir, 'agent-a.jsonl');
    const first = user(1, 'task') + toolLine(2);
    fs.writeFileSync(file, first);
    const reader = new SubagentTranscriptReader();
    reader.attach(file);
    await reader.refresh();

    const reads: number[] = [];
    let opens = 0;
    const realOpen = fs.promises.open.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
      opens++;
      const handle = await realOpen(...args);
      const realRead = handle.read.bind(handle);
      (handle as unknown as { read: unknown }).read = (async (...a: unknown[]) => { reads.push(a[3] as number); return (realRead as (...x: unknown[]) => unknown)(...a); });
      return handle;
    });
    try {
      await reader.refresh();
      expect(opens).toBe(0);

      fs.appendFileSync(file, toolLine(3) + assistant(4, { id: 'f', blocks: [{ type: 'text', text: 'all done' }] }));
      const next = (await reader.refresh())!;
      expect(reads).toEqual([Buffer.byteLength(first)]);
      expect(next.entries).toHaveLength(2);
      expect(next.result).toBe('all done');
    } finally {
      spy.mockRestore();
    }
  });

  it('marks a failed call when its result arrives in a later read', async () => {
    const dir = tmp();
    const file = path.join(dir, 'agent-a.jsonl');
    fs.writeFileSync(file, user(1, 'task') + toolLine(2));
    const reader = new SubagentTranscriptReader();
    reader.attach(file);
    expect((await reader.refresh())!.entries[0]).not.toHaveProperty('failed');
    fs.appendFileSync(file, user(3, [{ type: 'tool_result', tool_use_id: 't2', content: 'x', is_error: true }]));
    expect((await reader.refresh())!.entries[0]).toMatchObject({ failed: true });
  });

  it('starts over when the file shrinks or a different file is attached, and returns null when it is gone', async () => {
    const dir = tmp();
    const file = path.join(dir, 'agent-a.jsonl');
    fs.writeFileSync(file, user(1, 'a long first task description') + toolLine(2));
    const reader = new SubagentTranscriptReader();
    reader.attach(file);
    await reader.refresh();
    fs.writeFileSync(file, user(1, 'new'));
    expect((await reader.refresh())!).toMatchObject({ prompt: 'new', entries: [] });
    fs.rmSync(file);
    expect(await reader.refresh()).toBeNull();
  });

  it('gives the same digest whether a transcript is folded whole or in pieces, past the entry cap', () => {
    const lines = Array.from({ length: 1000 }, (_, i) => toolLine(i + 2));
    const whole = parseSubagentTranscript(lines.join(''));
    const state = createTranscriptState();
    for (let i = 0; i < lines.length; i += 137) foldTranscriptLines(state, lines.slice(i, i + 137).join(''));
    expect(finishTranscript(state)).toEqual(whole);
    expect(whole.truncated).toBe(true);
    expect(whole.entries).toHaveLength(400);
  });
});
