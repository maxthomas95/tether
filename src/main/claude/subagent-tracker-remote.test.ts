import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUNNING_WINDOW_MS, SubagentTracker, type RemoteSubagentSource, type TrackedSession } from './subagent-tracker';
import { createSubagentScan, foldSubagentLines, type SubagentSnapshot } from './subagents';
import type { RemoteProbeTarget } from '../usage/remote-protocol';

const SESSION = '11111111-2222-4333-8444-555555555555';
const TARGET: RemoteProbeTarget = { environmentId: 'env', workspace: 'owner/ws', workingDir: '.' };
const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

function snapshot(id: string, mtimeAgoMs: number, output = 5): SubagentSnapshot {
  const scan = createSubagentScan();
  foldSubagentLines(scan, JSON.stringify({ type: 'assistant', timestamp: new Date(NOW - 5000).toISOString(), message: { id: `${id}-m`, model: 'claude-test-model', content: [], usage: { output_tokens: output } } }) + '\n');
  return { id, meta: { agentType: 'tester' }, scan, mtimeMs: NOW - mtimeAgoMs, birthMs: NOW - 60_000 };
}

class FakeSource implements RemoteSubagentSource {
  snapshots: SubagentSnapshot[] = [];
  backlog = false;
  refresh = vi.fn(async () => ({ snapshots: this.snapshots, total: this.snapshots.length }));
  transcript = vi.fn(async (agentId: string) => (agentId === 'a1'
    ? { prompt: 'Count widgets', entries: [], result: 'Three.', truncated: false }
    : null));
  releaseTranscript = vi.fn();
  releaseAllTranscripts = vi.fn();
  resetLookup = vi.fn();
  setAlive = vi.fn();
  close = vi.fn();
}

let clock = NOW;
let session: TrackedSession;
let source: FakeSource;
let openRemote: ReturnType<typeof vi.fn>;
let tracker: SubagentTracker;
const updates: unknown[] = [];

beforeEach(() => {
  clock = NOW;
  source = new FakeSource();
  openRemote = vi.fn(() => source);
  session = { cliTool: 'claude', workingDir: '/home/me/repo', nativeSessionId: SESSION, local: false, remote: TARGET, alive: true, hookDriven: false, activeAgentIds: [] };
  tracker = new SubagentTracker();
  tracker.configure({ resolve: id => (id === 's1' ? session : null), isEnabled: () => true, openRemote, now: () => clock });
  tracker.onUpdate((_id, list) => updates.push(list));
  updates.length = 0;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => { tracker.dispose(); vi.useRealTimers(); });

describe('SubagentTracker remote sessions', () => {
  it('opens one source for the session and reuses it across refreshes', async () => {
    source.snapshots = [snapshot('a1', 0)];
    expect((await tracker.list('s1')).agents.map(a => a.id)).toEqual(['a1']);
    await tracker.list('s1');
    await tracker.list('s1');
    expect(openRemote).toHaveBeenCalledOnce();
    expect(openRemote).toHaveBeenCalledWith(TARGET, SESSION);
    expect(source.refresh).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['the setting is off', () => { tracker.configure({ resolve: () => session, isEnabled: () => false, openRemote }); }],
    ['the session has no Claude id yet', () => { session.nativeSessionId = null; }],
    ['it is a Codex session', () => { session.cliTool = 'codex'; }],
    ['no remote reader is wired', () => { tracker.configure({ resolve: () => session, isEnabled: () => true }); }],
    ['the session is remote but has no target', () => { session.remote = undefined; }],
  ])('reads nothing from the remote when %s', async (_name, change) => {
    source.snapshots = [snapshot('a1', 0)];
    change();
    expect(await tracker.list('s1')).toEqual({ agents: [], total: 0 });
    expect(openRemote).not.toHaveBeenCalled();
    expect(source.refresh).not.toHaveBeenCalled();
  });

  it('uses the 30 second file rule without hooks and the hook set with them', async () => {
    source.snapshots = [snapshot('fresh', RUNNING_WINDOW_MS - 5_000), snapshot('stale', RUNNING_WINDOW_MS + 5_000)];
    expect(Object.fromEntries((await tracker.list('s1')).agents.map(a => [a.id, a.state]))).toEqual({ fresh: 'running', stale: 'done' });

    session.hookDriven = true;
    session.activeAgentIds = ['stale'];
    expect(Object.fromEntries((await tracker.list('s1')).agents.map(a => [a.id, a.state]))).toEqual({ fresh: 'done', stale: 'running' });
  });

  it('polls only while something runs or the list is open, plus slow discovery without hooks', async () => {
    session.hookDriven = true;
    source.snapshots = [snapshot('a1', 0)];
    await tracker.list('s1');
    expect(vi.getTimerCount()).toBe(0);

    session.activeAgentIds = ['a1'];
    await tracker.list('s1');
    expect(vi.getTimerCount()).toBe(1);
    const before = source.refresh.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2_600);
    expect(source.refresh.mock.calls.length).toBe(before + 1);

    session.activeAgentIds = [];
    await vi.advanceTimersByTimeAsync(2_600);
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0));

    session.hookDriven = false;
    await tracker.list('s1');
    expect(vi.getTimerCount()).toBe(1);
  });

  it('does not poll every 250 ms through a failing remote even if the source still claims a backlog', async () => {
    session.hookDriven = true;
    source.snapshots = [snapshot('a1', 10 * 60_000)];
    source.backlog = true;
    await tracker.list('s1');
    expect(vi.getTimerCount()).toBe(1);   // the 250 ms backlog poll
    source.refresh.mockRejectedValue(new Error('Remote usage reader unavailable'));
    await tracker.list('s1');
    const before = source.refresh.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    // Idle and hook-driven: a failed refresh leaves nothing to poll for, not a 250 ms loop.
    expect(source.refresh.mock.calls.length).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the fast poll for a hook-announced subagent with no file for a minute at most', async () => {
    session.hookDriven = true;
    session.activeAgentIds = ['ghost'];
    source.snapshots = [];
    await tracker.list('s1');
    expect(vi.getTimerCount()).toBe(1);
    clock += 61_000;
    await tracker.list('s1');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('asks again right away while the remote reports more unread data, then settles', async () => {
    session.hookDriven = true;
    source.snapshots = [snapshot('a1', 0)];
    source.backlog = true;
    await tracker.list('s1');
    const before = source.refresh.mock.calls.length;
    await vi.advanceTimersByTimeAsync(300);
    expect(source.refresh.mock.calls.length).toBe(before + 1);
    source.backlog = false;
    await vi.advanceTimersByTimeAsync(300);
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0));
  });

  it('keeps the last list and retries on the normal cadence when the remote is unreachable', async () => {
    source.snapshots = [snapshot('a1', 0)];
    expect((await tracker.list('s1')).agents).toHaveLength(1);
    source.refresh.mockRejectedValue(new Error('Remote usage reader unavailable'));
    expect((await tracker.list('s1')).agents).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
    source.refresh.mockImplementation(async () => ({ snapshots: [snapshot('a1', 0), snapshot('a2', 0)], total: 2 }));
    await vi.advanceTimersByTimeAsync(10_100);
    await vi.waitFor(() => expect((updates.at(-1) as { agents: unknown[] }).agents).toHaveLength(2));
  });

  it('releases the source when the session is untracked or adopts another Claude id', async () => {
    source.snapshots = [snapshot('a1', 0)];
    await tracker.list('s1');
    session.nativeSessionId = '99999999-2222-4333-8444-555555555555';
    const second = new FakeSource();
    openRemote.mockReturnValue(second);
    await tracker.list('s1');
    expect(source.close).toHaveBeenCalledOnce();
    expect(openRemote).toHaveBeenLastCalledWith(TARGET, '99999999-2222-4333-8444-555555555555');
    tracker.untrack('s1');
    expect(second.close).toHaveBeenCalledOnce();
  });

  it('tells the source whether the session is alive on every refresh', async () => {
    source.snapshots = [snapshot('a1', 0)];
    await tracker.list('s1');
    expect(source.setAlive).toHaveBeenLastCalledWith(true);
    session.alive = false;
    await tracker.list('s1');
    expect(source.setAlive).toHaveBeenLastCalledWith(false);
  });

  it('passes viewer release, renderer reload and subagent hook events through to the source', async () => {
    source.snapshots = [snapshot('a1', 0)];
    await tracker.list('s1');
    tracker.releaseTranscript('s1', 'a1');
    expect(source.releaseTranscript).toHaveBeenCalledWith('a1');
    tracker.resetExpanded();
    expect(source.releaseAllTranscripts).toHaveBeenCalledOnce();
    tracker.notify('s1');
    expect(source.resetLookup).not.toHaveBeenCalled();
    tracker.notify('s1', { subagentEvent: true });
    expect(source.resetLookup).toHaveBeenCalledOnce();
  });

  it('serves the viewer digest from the remote source', async () => {
    source.snapshots = [snapshot('a1', 0)];
    const transcript = await tracker.getTranscript('s1', 'a1');
    expect(transcript?.prompt).toBe('Count widgets');
    expect(transcript?.result).toBe('Three.');
    expect(transcript?.agent.id).toBe('a1');
    expect(await tracker.getTranscript('s1', 'missing')).toBeNull();
    expect(source.transcript).toHaveBeenCalledOnce();
  });
});
