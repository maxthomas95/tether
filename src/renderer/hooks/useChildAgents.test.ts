// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChildAgents, type ChildAgentsState } from './useChildAgents';
import type { ChildAgentList } from '../../shared/child-agents';
import type { EnvironmentInfo, SessionInfo } from '../../shared/types';

const session = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
  id, environmentId: null, label: id, workingDir: '/w', state: 'running', createdAt: '2026-01-01T00:00:00Z', claudeSessionId: `claude-${id}`, ...over,
});
const list = (n: number): ChildAgentList => ({ total: n, agents: [] });
const envs = new Map<string, EnvironmentInfo>([['ssh-1', { id: 'ssh-1', type: 'ssh' } as EnvironmentInfo]]);

let root: Root;
let state: ChildAgentsState;
let sessions: SessionInfo[];
let setting: string | null;
let listCall: ReturnType<typeof vi.fn>;
let setExpanded: ReturnType<typeof vi.fn>;
let push: (id: string, l: ChildAgentList) => void;
let unsubscribe: ReturnType<typeof vi.fn>;

function Harness() { state = useChildAgents(sessions, envs); return null; }
const render = () => act(async () => root.render(createElement(Harness)));

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  setting = null;
  sessions = [session('s1')];
  listCall = vi.fn(async (id: string) => list(id === 's1' ? 1 : 2));
  setExpanded = vi.fn();
  unsubscribe = vi.fn();
  vi.stubGlobal('electronAPI', {
    config: { get: vi.fn(async () => setting) },
    subagents: {
      list: listCall, setExpanded,
      onUpdate: (cb: typeof push) => { push = cb; return unsubscribe; },
    },
  });
  root = createRoot(document.createElement('div'));
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

describe('useChildAgents', () => {
  it('fetches each eligible session once and keeps pushed updates', async () => {
    sessions = [session('s1'), session('s2', { environmentId: 'ssh-1' }), session('s3', { cliTool: 'codex' }), session('s4', { claudeSessionId: undefined })];
    await render();
    await render();
    expect(listCall).toHaveBeenCalledTimes(1);
    expect(listCall).toHaveBeenCalledWith('s1');
    expect(state.lists.get('s1')).toEqual(list(1));
    await act(async () => push('s1', list(5)));
    expect(state.lists.get('s1')?.total).toBe(5);
  });

  it('fetches a session once its Claude id appears', async () => {
    sessions = [session('s1', { claudeSessionId: undefined })];
    await render();
    expect(listCall).not.toHaveBeenCalled();
    sessions = [session('s1', { claudeSessionId: 'now-known' })];
    await render();
    expect(listCall).toHaveBeenCalledWith('s1');
  });

  it('forgets sessions that went away', async () => {
    sessions = [session('s1'), session('s2')];
    await render();
    expect(state.lists.size).toBe(2);
    sessions = [session('s2')];
    await render();
    expect([...state.lists.keys()]).toEqual(['s2']);
  });

  it('does nothing while the setting is off, and starts once it is turned on', async () => {
    setting = 'false';
    await render();
    expect(listCall).not.toHaveBeenCalled();
    expect(state.lists.size).toBe(0);
    setting = 'true';
    await act(async () => window.dispatchEvent(new Event('tether:settings-changed')));
    expect(listCall).toHaveBeenCalledWith('s1');
    expect(state.lists.get('s1')).toBeDefined();
    setting = 'false';
    await act(async () => window.dispatchEvent(new Event('tether:settings-changed')));
    expect(state.lists.size).toBe(0);
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('treats an unreadable setting as on', async () => {
    (window.electronAPI.config.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('unavailable'));
    await render();
    expect(listCall).toHaveBeenCalledWith('s1');
  });

  it('tells main when a list is opened or closed', async () => {
    await render();
    expect(state.expandedIds.has('s1')).toBe(false);
    await act(async () => state.toggleExpanded('s1'));
    expect(state.expandedIds.has('s1')).toBe(true);
    expect(setExpanded).toHaveBeenLastCalledWith('s1', true);
    await act(async () => state.toggleExpanded('s1'));
    expect(state.expandedIds.has('s1')).toBe(false);
    expect(setExpanded).toHaveBeenLastCalledWith('s1', false);
  });

  it('retries a failed fetch on the next change instead of giving up', async () => {
    listCall.mockRejectedValueOnce(new Error('boom'));
    await render();
    expect(listCall).toHaveBeenCalledTimes(1);
    sessions = [session('s1'), session('s9')];
    await render();
    expect(listCall).toHaveBeenCalledWith('s1');
    expect(state.lists.get('s1')).toBeDefined();
  });
});
