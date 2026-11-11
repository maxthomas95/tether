// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChildAgentViewer, type ChildAgentViewerState } from './useChildAgentViewer';
import type { ChildAgentInfo, ChildAgentList } from '../../shared/child-agents';

const agent = (id: string, over: Partial<ChildAgentInfo> = {}): ChildAgentInfo => ({
  source: 'claude-subagent', id, agentType: 'tester', description: 'Check', background: false, depth: 1, state: 'done',
  startedAt: '2026-01-01T12:00:00.000Z', lastActivityAt: '2026-01-01T12:00:41.000Z',
  tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, ...over,
});
const listOf = (...agents: ChildAgentInfo[]): ChildAgentList => ({ agents, total: agents.length });

let root: Root;
let state: ChildAgentViewerState;
let lists: Map<string, ChildAgentList>;
let saved: string | null;
let configSet: ReturnType<typeof vi.fn>;
let saveError: ReturnType<typeof vi.fn>;

function Harness() { state = useChildAgentViewer(lists, saveError); return null; }
const render = () => act(async () => root.render(createElement(Harness)));

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  saved = null;
  lists = new Map([['s1', listOf(agent('a1'), agent('a2'))], ['s2', listOf(agent('a1'))]]);
  configSet = vi.fn(async () => undefined);
  saveError = vi.fn();
  vi.stubGlobal('electronAPI', { config: { get: vi.fn(async () => saved), set: configSet } });
  root = createRoot(document.createElement('div'));
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); document.body.replaceChildren(); });

describe('useChildAgentViewer', () => {
  it('starts closed, opens on a row and swaps to another row', async () => {
    await render();
    expect(state.viewed).toBeNull();
    await act(async () => state.toggle('s1', agent('a1')));
    expect(state.viewed).toMatchObject({ sessionId: 's1', agent: { id: 'a1' }, focusOnOpen: false });
    await act(async () => state.toggle('s1', agent('a2'), true));
    expect(state.viewed).toMatchObject({ sessionId: 's1', agent: { id: 'a2' }, focusOnOpen: true });
  });

  it('closes from the row it is showing, but not from a row with the same id in another session', async () => {
    await render();
    await act(async () => state.toggle('s1', agent('a1')));
    await act(async () => state.toggle('s2', agent('a1')));
    expect(state.viewed?.sessionId).toBe('s2');
    await act(async () => state.toggle('s2', agent('a1')));
    expect(state.viewed).toBeNull();
  });

  it('follows the sidebar row as it changes', async () => {
    await render();
    await act(async () => state.toggle('s1', agent('a1', { state: 'running' })));
    lists = new Map(lists).set('s1', listOf(agent('a1', { state: 'done', tokens: { input: 9, output: 9, cacheRead: 0, cacheWrite: 0 } })));
    await render();
    expect(state.viewed?.agent).toMatchObject({ state: 'done', tokens: { input: 9 } });
  });

  it('stays open on an agent that left the list, but no longer calls it running', async () => {
    await render();
    await act(async () => state.toggle('s1', agent('a1', { state: 'running' })));
    lists = new Map(lists).set('s1', listOf(agent('a2')));
    await render();
    expect(state.viewed).toMatchObject({ sessionId: 's1', agent: { id: 'a1', state: 'done' } });
  });

  it('closes when its session is removed or subagent rows are turned off', async () => {
    await render();
    await act(async () => state.toggle('s1', agent('a1')));
    lists = new Map([['s2', listOf(agent('a1'))]]);
    await render();
    expect(state.viewed).toBeNull();
    // It does not come back by itself when the list does.
    lists = new Map([['s1', listOf(agent('a1'))]]);
    await render();
    expect(state.viewed).toBeNull();
  });

  it('puts focus back on the row that opened it only when asked to', async () => {
    const row = document.createElement('div');
    row.tabIndex = 0;
    const elsewhere = document.createElement('button');
    document.body.append(row, elsewhere);
    await render();

    row.focus();
    await act(async () => state.toggle('s1', agent('a1'), true));
    elsewhere.focus();
    await act(async () => state.close());
    expect(document.activeElement).toBe(elsewhere);

    row.focus();
    await act(async () => state.toggle('s1', agent('a1'), true));
    elsewhere.focus();
    await act(async () => state.close(true));
    expect(document.activeElement).toBe(row);
    expect(state.viewed).toBeNull();
  });

  it('does not chase a row that is no longer on screen', async () => {
    const row = document.createElement('div');
    row.tabIndex = 0;
    document.body.append(row);
    await render();
    row.focus();
    await act(async () => state.toggle('s1', agent('a1'), true));
    row.remove();
    await act(async () => state.close(true));
    expect(document.activeElement).toBe(document.body);
  });

  it('uses the saved width, and saves a new one', async () => {
    saved = '512';
    await render();
    expect(state.width).toBe(512);
    await act(async () => state.setWidth(360));
    expect(state.width).toBe(360);
    await act(async () => state.saveWidth(360));
    expect(configSet).toHaveBeenCalledWith('childAgentPanelWidth', '360');
    expect(saveError).not.toHaveBeenCalled();
  });

  it('falls back to the default width when nothing usable was saved, and reports a failed save', async () => {
    saved = 'nonsense';
    await render();
    expect(state.width).toBe(400);
    configSet.mockRejectedValueOnce(new Error('disk full'));
    await act(async () => state.saveWidth(444));
    expect(saveError).toHaveBeenCalledWith(expect.objectContaining({ message: 'disk full' }));
  });
});
