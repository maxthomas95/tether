import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
}));

import { RUNNING_WINDOW_MS, SubagentTracker, type TrackedSession } from './subagent-tracker';
import type { ChildAgentList } from '../../shared/child-agents';

const SESSION = '11111111-2222-4333-8444-555555555555';
const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, n)).toISOString();
const line = (o: object) => JSON.stringify(o) + '\n';
const prompt = (n: number, text: string) => line({ type: 'user', timestamp: at(n), message: { role: 'user', content: text } });
const reply = (n: number, id: string, blocks: unknown[], output = 5) => line({
  type: 'assistant', timestamp: at(n), message: { id, role: 'assistant', model: 'claude-test-model', content: blocks, usage: { output_tokens: output } },
});

let home: string;
let subagents: string;
let session: TrackedSession;
let enabled: boolean;
let now: number;
let tracker: SubagentTracker;
const updates: Array<[string, ChildAgentList]> = [];

function write(id: string, body: string, mtimeAgoMs = 0) {
  const file = path.join(subagents, `agent-${id}.jsonl`);
  fs.writeFileSync(file, body);
  const when = new Date(now - mtimeAgoMs);
  fs.utimesSync(file, when, when);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-tracker-'));
  process.env.CLAUDE_CONFIG_DIR = home;
  subagents = path.join(home, 'projects', '-work-repo', SESSION, 'subagents');
  fs.mkdirSync(subagents, { recursive: true });
  now = Date.now();
  enabled = true;
  session = {
    cliTool: 'claude', workingDir: '/work/repo', nativeSessionId: SESSION, local: true,
    alive: true, hookDriven: false, activeAgentIds: [],
  };
  updates.length = 0;
  tracker = new SubagentTracker();
  tracker.configure({ resolve: id => (id === 's1' ? session : null), isEnabled: () => enabled, now: () => now });
  tracker.onUpdate((id, list) => updates.push([id, list]));
});

afterEach(() => {
  tracker.dispose();
  vi.useRealTimers();
  delete process.env.CLAUDE_CONFIG_DIR;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('SubagentTracker eligibility', () => {
  it.each([
    ['a Codex session', () => { session.cliTool = 'codex'; }],
    ['a remote session', () => { session.local = false; }],
    ['a session without a Claude id yet', () => { session.nativeSessionId = null; }],
    ['the setting turned off', () => { enabled = false; }],
  ])('lists nothing for %s even when subagent files exist', async (_name, change) => {
    write('a1', prompt(1, 'task'));
    change();
    expect(await tracker.list('s1')).toEqual({ agents: [], total: 0 });
  });

  it('lists nothing for a session it does not know', async () => {
    expect(await tracker.list('nope')).toEqual({ agents: [], total: 0 });
    expect(await tracker.getTranscript('nope', 'a1')).toBeNull();
  });

  it('finds nothing until the subagents folder exists, then finds it on a hook event', async () => {
    fs.rmSync(subagents, { recursive: true });
    expect((await tracker.list('s1')).agents).toEqual([]);
    fs.mkdirSync(subagents, { recursive: true });
    write('a1', prompt(1, 'task'));
    // Within the retry window a plain list does not rescan; a hook event does.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    tracker.notify('s1');
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(updates.at(-1)?.[1].agents).toHaveLength(1));
  });
});

describe('SubagentTracker running state', () => {
  it('trusts the hook-driven active set over file times', async () => {
    write('busy', prompt(1, 'task'), 10 * 60_000);
    write('quiet', prompt(1, 'task'), 0);
    session.hookDriven = true;
    session.activeAgentIds = ['busy'];
    const list = await tracker.list('s1');
    expect(Object.fromEntries(list.agents.map(a => [a.id, a.state]))).toEqual({ busy: 'running', quiet: 'done' });
  });

  it('falls back to recent file activity when hooks are off', async () => {
    write('fresh', prompt(1, 'task'), RUNNING_WINDOW_MS - 5_000);
    write('stale', prompt(1, 'task'), RUNNING_WINDOW_MS + 5_000);
    const list = await tracker.list('s1');
    expect(Object.fromEntries(list.agents.map(a => [a.id, a.state]))).toEqual({ fresh: 'running', stale: 'done' });
  });

  it('marks everything done once the session has ended', async () => {
    write('a1', prompt(1, 'task'));
    session.hookDriven = true;
    session.activeAgentIds = ['a1'];
    session.alive = false;
    expect((await tracker.list('s1')).agents[0].state).toBe('done');
  });
});

describe('SubagentTracker updates and polling', () => {
  it('pushes only when the list changes', async () => {
    write('a1', prompt(1, 'task') + reply(2, 'm1', []), 5 * 60_000);
    await tracker.list('s1');
    await tracker.list('s1');
    expect(updates).toHaveLength(1);
    write('a1', prompt(1, 'task') + reply(2, 'm1', []) + reply(3, 'm2', [], 9), 5 * 60_000);
    await tracker.list('s1');
    expect(updates).toHaveLength(2);
    expect(updates[1][1].agents[0].tokens.output).toBe(14);
  });

  it('debounces a burst of hook events into one refresh', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    write('a1', prompt(1, 'task'));
    for (let i = 0; i < 5; i++) tracker.notify('s1');
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(updates).toHaveLength(1));
  });

  it('polls quickly while a subagent runs and stops once nothing does', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    session.hookDriven = true;
    session.activeAgentIds = ['a1'];
    write('a1', prompt(1, 'task') + reply(2, 'm1', [], 5));
    await tracker.list('s1');
    expect(vi.getTimerCount()).toBe(1);

    write('a1', prompt(1, 'task') + reply(2, 'm1', [], 5) + reply(3, 'm2', [], 6));
    await vi.advanceTimersByTimeAsync(2_600);
    await vi.waitFor(() => expect(updates.at(-1)?.[1].agents[0].tokens.output).toBe(11));

    session.activeAgentIds = [];
    await vi.advanceTimersByTimeAsync(2_600);
    await vi.waitFor(() => expect(updates.at(-1)?.[1].agents[0].state).toBe('done'));
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0));
  });

  it('does not poll an idle hook-driven session unless its list is expanded', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    session.hookDriven = true;
    write('a1', prompt(1, 'task'));
    await tracker.list('s1');
    expect(vi.getTimerCount()).toBe(0);

    tracker.setExpanded('s1', true);
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
    tracker.setExpanded('s1', false);
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0));
  });

  it('keeps a slow discovery poll for a session without hooks so the first subagent shows up', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await tracker.list('s1');
    expect(vi.getTimerCount()).toBe(1);
  });

  it('stops polling a session that ended or was untracked', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await tracker.list('s1');
    expect(vi.getTimerCount()).toBe(1);
    tracker.untrack('s1');
    expect(vi.getTimerCount()).toBe(0);
    session.alive = false;
    await tracker.list('s1');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts over when the session adopts a different Claude id', async () => {
    write('a1', prompt(1, 'task'));
    expect((await tracker.list('s1')).agents).toHaveLength(1);
    session.nativeSessionId = '99999999-2222-4333-8444-555555555555';
    expect((await tracker.list('s1')).agents).toEqual([]);
  });
});

describe('SubagentTracker transcripts', () => {
  it('returns a digest for a listed subagent and nothing for others', async () => {
    write('a1', prompt(1, 'Count widgets') + reply(2, 'm1', [{ type: 'text', text: 'Three.' }]));
    const transcript = await tracker.getTranscript('s1', 'a1');
    expect(transcript?.prompt).toBe('Count widgets');
    expect(transcript?.result).toBe('Three.');
    expect(transcript?.agent.id).toBe('a1');
    expect(await tracker.getTranscript('s1', 'missing')).toBeNull();
    expect(await tracker.getTranscript('s1', '../../escape')).toBeNull();
  });
});
