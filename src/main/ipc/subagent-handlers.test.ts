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

const openRemoteMock = vi.hoisted(() => vi.fn());
vi.mock('../claude/remote-subagents', () => ({ openRemoteSubagentSource: openRemoteMock }));

import { IPC } from '../../shared/constants';
import { registerSubagentHandlers } from './subagent-handlers';

const harness = createHarness(registry);

function resolver() {
  return trackerMock.configure.mock.calls[0][0] as {
    resolve: (id: string) => unknown;
    isEnabled: () => boolean;
    openRemote: (target: unknown, sessionId: string) => unknown;
  };
}

describe('subagent-handlers', () => {
  beforeEach(() => {
    harness.reset();
    Object.values(trackerMock).forEach(m => m.mockReset());
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

  it.each(['ssh', 'coder'])('hands a %s session its remote reader target, and never a local session', type => {
    const remoteProbe = { environmentId: 'env-1', workspace: type === 'coder' ? 'owner/ws' : '', workingDir: '/repo' };
    envRepoMock.getEnvironment.mockReturnValue({ type });
    sessionManagerMock.getSession.mockReturnValue({
      cliTool: 'claude', workingDir: '/repo', environmentId: 'env-1', claudeSessionId: 'claude-id', toolSessionId: null, state: 'running', remoteProbe,
    });
    expect(resolver().resolve('s1')).toMatchObject({ local: false, remote: remoteProbe });
    envRepoMock.getEnvironment.mockReturnValue({ type: 'local' });
    expect((resolver().resolve('s1') as { remote?: unknown }).remote).toBeUndefined();
  });

  it('opens remote sources through the shared resident-reader module', () => {
    const source = {};
    openRemoteMock.mockReturnValue(source);
    const target = { environmentId: 'env-1', workspace: '', workingDir: '/repo' };
    expect(resolver().openRemote(target, 'claude-id')).toBe(source);
    expect(openRemoteMock).toHaveBeenCalledWith({ target, sessionId: 'claude-id' });
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
  });

  it('releases a transcript cache on request and ignores malformed ids', () => {
    harness.emit(IPC.SUBAGENTS_RELEASE_TRANSCRIPT, 's1', 'a1');
    harness.emit(IPC.SUBAGENTS_RELEASE_TRANSCRIPT, 's1', 5);
    expect(trackerMock.releaseTranscript).toHaveBeenCalledTimes(1);
    expect(trackerMock.releaseTranscript).toHaveBeenCalledWith('s1', 'a1');
  });

  it('refuses calls that do not come from the Tether window', async () => {
    const handler = registry.handlers.get(IPC.SUBAGENTS_LIST)!;
    expect(() => handler({ sender: {}, senderFrame: {} }, 's1')).toThrow('Tether window');
  });
});
