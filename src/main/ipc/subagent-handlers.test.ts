import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHarness, makeElectronMockBase, type IpcRegistry } from './ipc-test-harness.test-helper';

const registry = vi.hoisted<IpcRegistry>(() => ({ handlers: new Map(), listeners: new Map() }));
vi.mock('electron', () => makeElectronMockBase(registry));

const sessionManagerMock = vi.hoisted(() => ({
  getSession: vi.fn(),
  addLifecycleObserver: vi.fn(),
}));
vi.mock('../session/session-manager', () => ({ sessionManager: sessionManagerMock }));

const statusMock = vi.hoisted(() => ({
  isHookDriven: vi.fn(() => true),
  getActiveSubagentIds: vi.fn(() => ['agent-a']),
}));
vi.mock('../status/status-detector', () => ({ statusDetector: statusMock }));

const envRepoMock = vi.hoisted(() => ({ getEnvironment: vi.fn() }));
vi.mock('../db/environment-repo', () => envRepoMock);

const dbState = vi.hoisted(() => ({ config: {} as Record<string, string> }));
vi.mock('../db/database', () => ({ getDb: () => dbState }));

const trackerMock = vi.hoisted(() => ({
  configure: vi.fn(),
  onUpdate: vi.fn(),
  list: vi.fn(),
  getTranscript: vi.fn(),
  setExpanded: vi.fn(),
  notify: vi.fn(),
  untrack: vi.fn(),
  resetExpanded: vi.fn(),
  releaseTranscript: vi.fn(),
}));
vi.mock('../claude/subagent-tracker', () => ({ subagentTracker: trackerMock }));

const execMock = vi.hoisted(() => ({
  configure: vi.fn(),
  onUpdate: vi.fn(),
  list: vi.fn(),
  has: vi.fn(),
  getTranscript: vi.fn(),
  setExpanded: vi.fn(),
  resetExpanded: vi.fn(),
  releaseTranscript: vi.fn(),
  notify: vi.fn(),
  ingest: vi.fn(),
  untrack: vi.fn(),
}));
vi.mock('../codex/exec-tracker', () => ({ codexExecTracker: execMock }));
vi.mock('../codex/transcripts', () => ({ getCodexHome: () => '/codex-home' }));

import { IPC } from '../../shared/constants';
import type { ChildAgentInfo, ChildAgentList } from '../../shared/child-agents';
import { mergeChildAgentLists, registerSubagentHandlers } from './subagent-handlers';

const row = (source: ChildAgentInfo['source'], id: string): ChildAgentInfo => ({
  source, id, agentType: source === 'codex-exec' ? 'codex exec' : 'Explore', description: '', background: false, depth: 1,
  state: 'running', startedAt: '2026-01-01T12:00:00.000Z', lastActivityAt: '2026-01-01T12:00:00.000Z',
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});

const harness = createHarness(registry);

function resolver() {
  return trackerMock.configure.mock.calls[0][0] as {
    resolve: (id: string) => unknown;
    isEnabled: () => boolean;
  };
}

describe('subagent-handlers', () => {
  beforeEach(() => {
    harness.reset();
    Object.values(trackerMock).forEach(m => m.mockReset());
    Object.values(execMock).forEach(m => m.mockReset());
    execMock.list.mockResolvedValue({ agents: [], total: 0 });
    execMock.has.mockReturnValue(false);
    sessionManagerMock.getSession.mockReset();
    sessionManagerMock.addLifecycleObserver.mockReset();
    envRepoMock.getEnvironment.mockReset();
    dbState.config = {};
    registerSubagentHandlers(harness.ctx);
  });

  it('forwards tracker updates to the renderer', () => {
    const cb = trackerMock.onUpdate.mock.calls[0][0] as (id: string, list: unknown) => void;
    cb('s1', { agents: [], total: 0 });
    expect(harness.send).toHaveBeenCalledWith(IPC.SUBAGENTS_UPDATED, 's1', { agents: [], total: 0 });
  });

  it('is on unless the setting is the literal string false', () => {
    const { isEnabled } = resolver();
    expect(isEnabled()).toBe(true);
    dbState.config.showSubagentsInSidebar = 'true';
    expect(isEnabled()).toBe(true);
    dbState.config.showSubagentsInSidebar = 'false';
    expect(isEnabled()).toBe(false);
  });

  it('describes a live local Claude session from the session manager and status detector', () => {
    sessionManagerMock.getSession.mockReturnValue({
      cliTool: 'claude', workingDir: '/repo', environmentId: null, claudeSessionId: 'claude-id', toolSessionId: 'tool-id', state: 'running',
    });
    expect(resolver().resolve('s1')).toEqual({
      cliTool: 'claude', workingDir: '/repo', nativeSessionId: 'claude-id', local: true, alive: true,
      hookDriven: true, activeAgentIds: ['agent-a'],
    });
  });

  it('treats an SSH or Coder environment as not local and a stopped session as not alive', () => {
    envRepoMock.getEnvironment.mockReturnValue({ type: 'ssh' });
    sessionManagerMock.getSession.mockReturnValue({
      cliTool: 'claude', workingDir: '/repo', environmentId: 'env-1', claudeSessionId: null, toolSessionId: 'tool-id', state: 'stopped',
    });
    expect(resolver().resolve('s1')).toMatchObject({ local: false, alive: false, nativeSessionId: 'tool-id' });
    envRepoMock.getEnvironment.mockReturnValue({ type: 'local' });
    expect(resolver().resolve('s1')).toMatchObject({ local: true });
  });

  it('returns null for an unknown session', () => {
    sessionManagerMock.getSession.mockReturnValue(undefined);
    expect(resolver().resolve('nope')).toBeNull();
  });

  it('wires the lifecycle events that should refresh or drop a session', () => {
    const observer = sessionManagerMock.addLifecycleObserver.mock.calls[0][0] as {
      onStateChanged: (s: { id: string }) => void;
      onSubagentEvent: (s: { id: string }) => void;
      onRemoved: (id: string) => void;
    };
    observer.onStateChanged({ id: 's1' });
    observer.onSubagentEvent({ id: 's2' });
    observer.onRemoved('s3');
    expect(trackerMock.notify).toHaveBeenCalledWith('s1');
    expect(trackerMock.notify).toHaveBeenCalledWith('s2', { subagentEvent: true });
    expect(trackerMock.untrack).toHaveBeenCalledWith('s3');
  });

  it('answers list and transcript calls through the tracker', async () => {
    trackerMock.list.mockResolvedValue({ agents: [], total: 0 });
    trackerMock.getTranscript.mockResolvedValue({ prompt: 'x' });
    expect(await harness.invoke(IPC.SUBAGENTS_LIST, 's1')).toEqual({ agents: [], total: 0 });
    expect(await harness.invoke(IPC.SUBAGENTS_TRANSCRIPT, 's1', 'a1')).toEqual({ prompt: 'x' });
    expect(trackerMock.list).toHaveBeenCalledWith('s1');
    expect(trackerMock.getTranscript).toHaveBeenCalledWith('s1', 'a1');
  });

  it('describes a local live Claude session to the codex exec tracker, and a remote or stopped one as not', () => {
    const deps = execMock.configure.mock.calls[0][0] as {
      resolve: (id: string) => unknown;
      isEnabled: () => boolean;
      codexHome: () => string;
    };
    sessionManagerMock.getSession.mockReturnValue({ cliTool: 'claude', environmentId: null, state: 'running' });
    expect(deps.resolve('s1')).toEqual({ cliTool: 'claude', local: true, alive: true });
    envRepoMock.getEnvironment.mockReturnValue({ type: 'coder' });
    sessionManagerMock.getSession.mockReturnValue({ cliTool: 'claude', environmentId: 'env-1', state: 'stopped' });
    expect(deps.resolve('s1')).toEqual({ cliTool: 'claude', local: false, alive: false });
    sessionManagerMock.getSession.mockReturnValue(undefined);
    expect(deps.resolve('nope')).toBeNull();
    dbState.config.showSubagentsInSidebar = 'false';
    expect(deps.isEnabled()).toBe(false);
    expect(deps.codexHome()).toBe('/codex-home');
  });

  it('hands Codex hook events tagged with a Claude session to the codex exec tracker only', () => {
    const observer = sessionManagerMock.addLifecycleObserver.mock.calls[0][0] as {
      onStateChanged: (s: { id: string }) => void;
      onCodexExecEvent: (s: { id: string }, e: unknown) => void;
      onRemoved: (id: string) => void;
    };
    const event = { type: 'session_start', payload: { toolSessionId: 'thread-1' } };
    observer.onCodexExecEvent({ id: 's1' }, event);
    observer.onStateChanged({ id: 's1' });
    observer.onRemoved('s1');
    expect(execMock.ingest).toHaveBeenCalledWith('s1', event);
    expect(execMock.notify).toHaveBeenCalledWith('s1');
    expect(execMock.untrack).toHaveBeenCalledWith('s1');
  });

  it('merges subagents and codex exec runs, in that order, for list calls and pushes', async () => {
    const sub: ChildAgentList = { agents: [row('claude-subagent', 'a1')], total: 3 };
    const exec: ChildAgentList = { agents: [row('codex-exec', 'thread-1')], total: 1 };
    trackerMock.list.mockResolvedValue(sub);
    execMock.list.mockResolvedValue(exec);
    const listed = await harness.invoke(IPC.SUBAGENTS_LIST, 's1') as ChildAgentList;
    expect(listed.agents.map(a => a.id)).toEqual(['a1', 'thread-1']);
    expect(listed.total).toBe(4);

    const fromExec = execMock.onUpdate.mock.calls[0][0] as (id: string, list: ChildAgentList) => void;
    const fromSubagents = trackerMock.onUpdate.mock.calls[0][0] as (id: string, list: ChildAgentList) => void;
    harness.send.mockClear();
    fromExec('s2', exec);
    expect(harness.send).toHaveBeenLastCalledWith(IPC.SUBAGENTS_UPDATED, 's2', exec);
    fromSubagents('s2', sub);
    expect((harness.send.mock.lastCall as unknown[])[2]).toMatchObject({ total: 4 });
  });

  it('routes a transcript request to whichever tracker owns the id', async () => {
    trackerMock.getTranscript.mockResolvedValue({ prompt: 'claude' });
    execMock.getTranscript.mockResolvedValue({ prompt: 'codex' });
    execMock.has.mockImplementation((_s: string, id: string) => id === 'thread-1');
    expect(await harness.invoke(IPC.SUBAGENTS_TRANSCRIPT, 's1', 'thread-1')).toEqual({ prompt: 'codex' });
    expect(await harness.invoke(IPC.SUBAGENTS_TRANSCRIPT, 's1', 'a1')).toEqual({ prompt: 'claude' });
  });

  it('keeps the list shape unchanged when there are no codex exec runs', () => {
    const sub: ChildAgentList = { agents: [row('claude-subagent', 'a1')], total: 1 };
    const empty: ChildAgentList = { agents: [], total: 0 };
    expect(mergeChildAgentLists(sub, empty)).toBe(sub);
    expect(mergeChildAgentLists(empty, sub)).toBe(sub);
  });

  it('passes the expanded flag to the codex exec tracker too', () => {
    harness.emit(IPC.SUBAGENTS_SET_EXPANDED, 's1', true);
    expect(execMock.setExpanded).toHaveBeenCalledWith('s1', true);
  });

  it('rejects malformed arguments without touching the tracker', async () => {
    expect(await harness.invoke(IPC.SUBAGENTS_LIST, { id: 's1' })).toEqual({ agents: [], total: 0 });
    expect(await harness.invoke(IPC.SUBAGENTS_TRANSCRIPT, 's1', 42)).toBeNull();
    harness.emit(IPC.SUBAGENTS_SET_EXPANDED, 7, true);
    expect(trackerMock.list).not.toHaveBeenCalled();
    expect(trackerMock.getTranscript).not.toHaveBeenCalled();
    expect(trackerMock.setExpanded).not.toHaveBeenCalled();
  });

  it('passes the expanded flag through, treating anything but true as closed', () => {
    harness.emit(IPC.SUBAGENTS_SET_EXPANDED, 's1', true);
    harness.emit(IPC.SUBAGENTS_SET_EXPANDED, 's1', 'yes');
    expect(trackerMock.setExpanded).toHaveBeenNthCalledWith(1, 's1', true);
    expect(trackerMock.setExpanded).toHaveBeenNthCalledWith(2, 's1', false);
  });

  it('collapses every list when the renderer reloads or crashes', () => {
    const on = harness.ctx.mainWindow.webContents.on as unknown as ReturnType<typeof vi.fn>;
    const handlerFor = (name: string) => on.mock.calls.find(c => c[0] === name)![1] as () => void;
    handlerFor('did-start-loading')();
    handlerFor('render-process-gone')();
    expect(trackerMock.resetExpanded).toHaveBeenCalledTimes(2);
    expect(execMock.resetExpanded).toHaveBeenCalledTimes(2);
  });

  it('releases a transcript cache on request and ignores malformed ids', () => {
    harness.emit(IPC.SUBAGENTS_RELEASE_TRANSCRIPT, 's1', 'a1');
    harness.emit(IPC.SUBAGENTS_RELEASE_TRANSCRIPT, 's1', 5);
    expect(trackerMock.releaseTranscript).toHaveBeenCalledTimes(1);
    expect(trackerMock.releaseTranscript).toHaveBeenCalledWith('s1', 'a1');
    expect(execMock.releaseTranscript).toHaveBeenCalledWith('s1', 'a1');
  });

  it('refuses calls that do not come from the Tether window', async () => {
    const handler = registry.handlers.get(IPC.SUBAGENTS_LIST)!;
    expect(() => handler({ sender: {}, senderFrame: {} }, 's1')).toThrow('Tether window');
  });
});
