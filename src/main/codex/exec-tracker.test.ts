import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
}));

import { CoalescedRunner } from '../transcripts/child-tracker-support';
import { CodexExecTracker, NO_ROLLOUT_NOTE, type ExecTrackedSession } from './exec-tracker';
import type { ChildAgentList } from '../../shared/child-agents';
import { THREAD, THREAD_2, at, jsonl, sampleRollout } from './exec-fixtures.test-helper';

const BASE = Date.UTC(2026, 0, 1, 12, 0, 0);
const sec = (n: number) => BASE + n * 1000;

let codexHome: string;
let sessions: Map<string, ExecTrackedSession>;
let enabled: boolean;
let now: number;
let tracker: CodexExecTracker;
const updates: Array<[string, ChildAgentList]> = [];

const claudeSession = (over: Partial<ExecTrackedSession> = {}): ExecTrackedSession => ({
  cliTool: 'claude', local: true, alive: true, ...over,
});

function rolloutPath(id: string, startSeconds: number, nameDays = 0): string {
  const d = new Date(sec(startSeconds));
  d.setDate(d.getDate() + nameDays);
  const p = (n: number) => String(n).padStart(2, '0');
  const dir = path.join(codexHome, 'sessions', String(d.getFullYear()), p(d.getMonth() + 1), p(d.getDate()));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `rollout-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}-${id}.jsonl`);
}

function writeRollout(opts: {
  id?: string; start?: number; cwd?: string; done?: boolean; mtime?: number;
  /** Shift the date in the file name and folder, as a timezone or DST difference would. */
  nameDays?: number;
} = {}): string {
  const start = opts.start ?? 5;
  const file = rolloutPath(opts.id ?? THREAD, start, opts.nameDays ?? 0);
  fs.writeFileSync(file, sampleRollout({ ...opts, start }));
  const when = new Date(sec(opts.mtime ?? start + 7));
  fs.utimesSync(file, when, when);
  return file;
}

const hook = (type: string, seconds: number, payload: Record<string, unknown> = {}) => ({
  type, payload: { toolSessionId: THREAD, model: 'hook-model', at: new Date(sec(seconds)).toISOString(), ...payload },
});

beforeEach(() => {
  codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-codex-home-'));
  sessions = new Map([['s1', claudeSession()]]);
  enabled = true;
  now = sec(100);
  updates.length = 0;
  tracker = new CodexExecTracker();
  tracker.configure({
    resolve: id => sessions.get(id) ?? null,
    isEnabled: () => enabled,
    codexHome: () => codexHome,
    now: () => now,
  });
  tracker.onUpdate((id, list) => updates.push([id, list]));
});

afterEach(() => {
  tracker.dispose();
  vi.useRealTimers();
  fs.rmSync(codexHome, { recursive: true, force: true });
});

describe('hook events become children keyed by Codex thread id', () => {
  it('shows a run as running from its first hook, with the model the hook carried', async () => {
    tracker.ingest('s1', hook('session_start', 90));
    const list = await tracker.list('s1');
    expect(list.total).toBe(1);
    expect(list.agents[0]).toMatchObject({
      source: 'codex-exec', id: THREAD, agentType: 'codex exec', model: 'hook-model', state: 'running', depth: 1,
    });
  });

  it.each([
    ['UserPromptSubmit', 'turn_start'],
    ['PostToolUse', 'tool_complete'],
    ['PermissionRequest', 'permission_prompt'],
    ['PreCompact', 'compact_start'],
  ])('treats %s as the run being active', async (_name, type) => {
    tracker.ingest('s1', hook(type, 90));
    expect((await tracker.list('s1')).agents[0].state).toBe('running');
  });

  it.each(['turn_complete', 'session_end', 'turn_interrupted'])('treats %s as the run being done', async type => {
    tracker.ingest('s1', hook('turn_start', 90));
    tracker.ingest('s1', hook(type, 95));
    expect((await tracker.list('s1')).agents[0].state).toBe('done');
  });

  it('starts running again on a later turn of the same thread without adding a row', async () => {
    tracker.ingest('s1', hook('turn_complete', 90));
    tracker.ingest('s1', hook('turn_start', 95));
    const list = await tracker.list('s1');
    expect(list.agents).toHaveLength(1);
    expect(list.agents[0].state).toBe('running');
  });

  it('ignores events that arrive out of order', async () => {
    tracker.ingest('s1', hook('turn_complete', 95));
    tracker.ingest('s1', hook('tool_complete', 92));
    expect((await tracker.list('s1')).agents[0].state).toBe('done');
  });

  it('keeps separate runs separate', async () => {
    tracker.ingest('s1', hook('turn_start', 90));
    tracker.ingest('s1', hook('turn_start', 91, { toolSessionId: THREAD_2 }));
    expect((await tracker.list('s1')).agents.map(a => a.id).sort()).toEqual([THREAD, THREAD_2].sort());
  });

  it('does not make Codex subagents, or events a Codex subagent sends, into children', async () => {
    tracker.ingest('s1', hook('subagent_start', 90, { agentId: 'sub-1' }));
    tracker.ingest('s1', hook('subagent_stop', 91, { agentId: 'sub-1' }));
    tracker.ingest('s1', hook('tool_complete', 92, { toolSessionId: THREAD_2, agentId: 'sub-1' }));
    expect(await tracker.list('s1')).toEqual({ agents: [], total: 0 });
  });

  // codex-rs/hooks/src/schema.rs: these carry `agent_id` only when fired inside a Codex subagent.
  it.each(['turn_start', 'tool_complete', 'permission_prompt', 'compact_start', 'compact_complete'])(
    'ignores a %s event that carries an agent id, as one fired inside a Codex subagent does',
    async type => {
      tracker.ingest('s1', hook(type, 90, { agentId: 'sub-1' }));
      expect(await tracker.list('s1')).toEqual({ agents: [], total: 0 });
    },
  );

  it.each(['session_start', 'turn_complete', 'turn_interrupted', 'session_end'])(
    'accepts %s, which never carries an agent id',
    async type => {
      tracker.ingest('s1', hook(type, 90));
      expect((await tracker.list('s1')).agents.map(a => a.id)).toEqual([THREAD]);
    },
  );

  it('ignores events with no usable thread id or an unknown type', async () => {
    tracker.ingest('s1', { type: 'turn_start', payload: {} });
    tracker.ingest('s1', { type: 'turn_start', payload: { toolSessionId: '../../x' } });
    tracker.ingest('s1', { type: 'auth_success', payload: { toolSessionId: THREAD } });
    tracker.ingest('s1', { type: 'turn_start' });
    expect((await tracker.list('s1')).agents).toEqual([]);
  });

  it.each([
    ['a Codex session', () => { sessions.set('s1', claudeSession({ cliTool: 'codex' })); }],
    ['a remote session', () => { sessions.set('s1', claudeSession({ local: false })); }],
    ['the setting turned off', () => { enabled = false; }],
  ])('shows nothing for %s', async (_name, change) => {
    change();
    tracker.ingest('s1', hook('turn_start', 90));
    expect(await tracker.list('s1')).toEqual({ agents: [], total: 0 });
  });

  it('ignores a session it does not know', async () => {
    tracker.ingest('nope', hook('turn_start', 90));
    expect(await tracker.list('nope')).toEqual({ agents: [], total: 0 });
    expect(await tracker.getTranscript('nope', THREAD)).toBeNull();
  });

  it('does not keep a run running once its Claude session has stopped', async () => {
    tracker.ingest('s1', hook('turn_start', 90));
    sessions.set('s1', claudeSession({ alive: false }));
    expect((await tracker.list('s1')).agents[0].state).toBe('done');
  });

  it('lists a run under each session whose pane reported it', async () => {
    sessions.set('s2', claudeSession());
    tracker.ingest('s1', hook('turn_start', 90));
    tracker.ingest('s2', hook('tool_complete', 91));
    expect((await tracker.list('s1')).agents).toHaveLength(1);
    expect((await tracker.list('s2')).agents).toHaveLength(1);
  });

  it('caps the rows kept per session at the 50 newest', async () => {
    for (let i = 0; i < 55; i++) {
      tracker.ingest('s1', hook('turn_complete', 10 + i, { toolSessionId: `019bbbbb-0000-7000-8000-${String(i).padStart(12, '0')}` }));
    }
    const list = await tracker.list('s1');
    expect(list.total).toBe(50);
    expect(list.agents.some(a => a.id.endsWith('000000000054'))).toBe(true);
    expect(list.agents.some(a => a.id.endsWith('000000000000'))).toBe(false);
  });
});

describe('rollout detail for hook-reported runs', () => {
  it('adds prompt, model, effort and tokens once the rollout exists, and follows it to done', async () => {
    tracker.ingest('s1', hook('session_start', 5));
    writeRollout({ done: false, mtime: 99 });
    const running = (await tracker.list('s1')).agents[0];
    expect(running).toMatchObject({
      description: 'Review the module and list risks.', model: 'test-model', effort: 'high', state: 'running',
      tokens: { input: 1400, output: 120, cacheRead: 600, cacheWrite: 0 },
    });
    tracker.ingest('s1', hook('turn_complete', 12));
    expect((await tracker.list('s1')).agents[0].state).toBe('done');
  });

  it('finds a rollout that started on the previous day, for a run that spans midnight', async () => {
    const midnight = new Date(2026, 5, 10, 0, 0, 0).getTime();
    now = midnight + 5 * 60_000;
    const started = new Date(midnight - 120_000);
    const dir = path.join(codexHome, 'sessions', '2026', '06', '09');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `rollout-${started.getFullYear()}-06-09T23-58-00-${THREAD}.jsonl`), sampleRollout({ done: false }));
    tracker.ingest('s1', { type: 'turn_start', payload: { toolSessionId: THREAD, at: new Date(now - 1000).toISOString() } });
    expect((await tracker.list('s1')).agents[0].description).toBe('Review the module and list risks.');
  });

  it('shows nothing for a run whose hooks never arrived, however plain its rollout is', async () => {
    writeRollout();
    expect(await tracker.list('s1')).toEqual({ agents: [], total: 0 });
  });

  it('does not take a rollout named for the thread whose own header is another thread', async () => {
    tracker.ingest('s1', hook('session_start', 5));
    const file = writeRollout({ id: THREAD });
    fs.writeFileSync(file, sampleRollout({ id: THREAD_2 }));
    const list = await tracker.list('s1');
    expect(list.agents[0]).toMatchObject({ id: THREAD, description: '', model: 'hook-model' });
  });

  it('serves the viewer digest from the rollout', async () => {
    tracker.ingest('s1', hook('session_start', 5));
    writeRollout();
    const transcript = await tracker.getTranscript('s1', THREAD);
    expect(transcript?.prompt).toBe('Review the module and list risks.\nBe brief.');
    expect(transcript?.entries).toEqual([{ kind: 'tool', name: 'shell', summary: 'ls src' }]);
    expect(transcript?.result).toBe('Two risks found.');
    expect(transcript?.agent.id).toBe(THREAD);
    expect(transcript?.note).toBeUndefined();
  });

  it('shows a run with no rollout (ephemeral) from hook data alone and says so in the viewer', async () => {
    tracker.ingest('s1', hook('session_start', 90));
    const list = await tracker.list('s1');
    expect(list.agents[0]).toMatchObject({ description: '', model: 'hook-model', tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    const transcript = await tracker.getTranscript('s1', THREAD);
    expect(transcript).toMatchObject({ prompt: null, entries: [], result: null, note: NO_ROLLOUT_NOTE });
  });

  it('returns no transcript for a thread it never saw', async () => {
    expect(await tracker.getTranscript('s1', THREAD_2)).toBeNull();
    expect(await tracker.getTranscript('s1', '../x')).toBeNull();
  });

  it('pushes an update when a run changes and not when nothing did', async () => {
    tracker.ingest('s1', hook('turn_start', 90));
    await tracker.list('s1');
    const count = updates.length;
    await tracker.list('s1');
    expect(updates).toHaveLength(count);
    tracker.ingest('s1', hook('turn_complete', 95));
    await tracker.list('s1');
    expect(updates.length).toBe(count + 1);
    expect(updates.at(-1)?.[1].agents[0].state).toBe('done');
  });
});

describe('viewer readers and polling bounds', () => {
  const open = (): { size: number; keys(): string[] } => (tracker as unknown as { transcripts: { size: number; keys(): string[] } }).transcripts;

  it('keeps one incremental reader per open run and drops it on release or untrack', async () => {
    tracker.ingest('s1', hook('session_start', 5));
    writeRollout();
    await tracker.getTranscript('s1', THREAD);
    await tracker.getTranscript('s1', THREAD);
    expect(open().keys()).toEqual([`s1:${THREAD}`]);
    tracker.releaseTranscript('s1', THREAD);
    expect(open().size).toBe(0);
    await tracker.getTranscript('s1', THREAD);
    tracker.untrack('s1');
    expect(open().size).toBe(0);
  });

  it('does not keep more than a few readers for viewers that never released', async () => {
    for (let i = 0; i < 12; i++) {
      const id = `019bbbbb-0000-7000-8000-${String(i).padStart(12, '0')}`;
      tracker.ingest('s1', hook('turn_complete', 10 + i, { toolSessionId: id }));
      await tracker.getTranscript('s1', id);
    }
    expect(open().size).toBe(8);
  });

  it('follows a rollout as it grows without re-reading it from the start', async () => {
    tracker.ingest('s1', hook('session_start', 5));
    const file = writeRollout({ done: false });
    expect((await tracker.getTranscript('s1', THREAD))?.result).toBe('Two risks found.');
    fs.appendFileSync(file, jsonl(
      { timestamp: at(9), type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Finished.' } },
    ));
    expect((await tracker.getTranscript('s1', THREAD))?.result).toBe('Finished.');
  });

  it('collapses every list and forgets open viewers when the renderer reloads', async () => {
    tracker.ingest('s1', hook('session_start', 5));
    writeRollout();
    await tracker.list('s1');
    tracker.setExpanded('s1', true);
    await tracker.getTranscript('s1', THREAD);
    tracker.resetExpanded();
    expect(open().size).toBe(0);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    tracker.setExpanded('s1', true);
    await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
    tracker.resetExpanded();
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0));
  });

  it('stops the fast poll for a hook-only run a minute after its first hook, leaving only a slow tick', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        now = sec(100);
    tracker.ingest('s1', hook('turn_start', 100));
    await tracker.list('s1');
    const refresh = vi.spyOn(CoalescedRunner.prototype, 'request');
    await vi.advanceTimersByTimeAsync(2600);
    expect(refresh).toHaveBeenCalled();

    now = sec(100 + 61);
    tracker.ingest('s1', hook('tool_complete', 100 + 61));
    await tracker.list('s1');
    // The hook's own debounced refresh runs first; what follows is the schedule.
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
    refresh.mockClear();
    await vi.advanceTimersByTimeAsync(2600);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(7500);
    expect(refresh).toHaveBeenCalled();
  });
});

describe('scheduling', () => {
  it('keeps polling while a run is running, and stops once everything is done and the turn is over', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        tracker.ingest('s1', hook('turn_start', 99));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(updates.at(-1)?.[1].agents[0]?.state).toBe('running'));
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
    tracker.ingest('s1', hook('turn_complete', 100));
    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(updates.at(-1)?.[1].agents[0]?.state).toBe('done'));
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0));
  });

  it('forgets a session on untrack', async () => {
    tracker.ingest('s1', hook('turn_start', 90));
    await tracker.list('s1');
    tracker.untrack('s1');
    expect(tracker.has('s1', THREAD)).toBe(false);
  });
});
