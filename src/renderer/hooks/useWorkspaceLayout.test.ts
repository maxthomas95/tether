// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { useWorkspaceLayout } from './useWorkspaceLayout';
import { getLeaves } from '../lib/layout-tree';

it('keeps both arrangements while switching modes and removes sessions from both', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let layout!: ReturnType<typeof useWorkspaceLayout>;
  function Harness() { layout = useWorkspaceLayout(); return null; }
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Harness)));
    act(() => {
      layout.layoutDispatch({ type: 'SET_ROOT', root: { type: 'leaf', id: 'split-a', sessionId: 'a' } });
      layout.canvasDispatch({ type: 'SEED', sessionIds: ['a', 'b', 'c', 'd', 'e'], focusedSessionId: 'b' });
    });
    const originalSplit = layout.layoutState.root;
    act(() => layout.setCanvasEnabled(true));
    expect(getLeaves(layout.layoutState.root)).toHaveLength(5);
    act(() => layout.canvasDispatch({ type: 'RECT', paneId: 'canvas-b', rect: { x: 1500, y: -500, width: 700, height: 400 } }));
    const originalPanels = layout.canvasState.panels;
    act(() => layout.setCanvasEnabled(false));
    expect(layout.layoutState.root).toBe(originalSplit);
    act(() => layout.setCanvasEnabled(true));
    expect(layout.canvasState.panels).toBe(originalPanels);
    act(() => layout.layoutDispatch({ type: 'REMOVE_SESSION', sessionId: 'a' }));
    expect(layout.canvasState.panels.some(p => p.sessionId === 'a')).toBe(false);
    expect(getLeaves(layout.splitLayoutState.root).some(p => p.sessionId === 'a')).toBe(false);
  } finally {
    await act(async () => root.unmount());
  }
});

it('opens a delayed duplicate after its original single pane is removed', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let layout!: ReturnType<typeof useWorkspaceLayout>;
  function Harness() { layout = useWorkspaceLayout(false); return null; }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(createElement(Harness)));
    act(() => {
      layout.layoutDispatch({ type: 'SET_ROOT', root: { type: 'leaf', id: 'original-pane', sessionId: 'original' } });
      layout.layoutDispatch({ type: 'SET_FOCUS', paneId: 'original-pane' });
    });
    // Retain the completion callback from the click, just as App does across
    // the SSH create IPC await. Remove the source before that await resolves.
    const onCreated = layout.openCreatedSession;
    let connected!: (sessionId: string) => void;
    const creation = new Promise<string>(resolve => { connected = resolve; }).then(onCreated);
    act(() => layout.layoutDispatch({ type: 'REMOVE_SESSION', sessionId: 'original' }));
    expect(layout.layoutState.root).toBeNull();
    await act(async () => { connected('duplicate'); await creation; });
    const leaves = getLeaves(layout.layoutState.root);
    expect(leaves.map(p => p.sessionId)).toEqual(['duplicate']);
    expect(layout.layoutState.focusedPaneId).toBe(leaves[0].id);
  } finally {
    await act(async () => root.unmount());
  }
});

it('uses current split capacity and focus when delayed duplicates finish', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let layout!: ReturnType<typeof useWorkspaceLayout>;
  function Harness() { layout = useWorkspaceLayout(); return null; }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(createElement(Harness)));
    act(() => {
      layout.layoutDispatch({ type: 'SET_MAX_PANES', maxPanes: 2 });
      layout.openCreatedSession('original');
      layout.openCreatedSession('other');
    });
    const original = getLeaves(layout.layoutState.root).find(p => p.sessionId === 'original')!;
    act(() => layout.layoutDispatch({ type: 'SET_FOCUS', paneId: original.id }));
    const onCreated = layout.openCreatedSession;
    // The layout was full at the click but has capacity when SSH completes.
    act(() => layout.layoutDispatch({ type: 'REMOVE_SESSION', sessionId: 'original' }));
    act(() => onCreated('duplicate'));
    expect(getLeaves(layout.layoutState.root).map(p => p.sessionId).sort()).toEqual(['duplicate', 'other']);
    const other = getLeaves(layout.layoutState.root).find(p => p.sessionId === 'other')!;
    act(() => {
      layout.layoutDispatch({ type: 'SET_FOCUS', paneId: other.id });
      layout.layoutDispatch({ type: 'TOGGLE_MAXIMIZE', paneId: other.id });
    });
    // Another completion uses the new focus at the current two-pane limit.
    act(() => onCreated('second-duplicate'));
    const leaves = getLeaves(layout.layoutState.root);
    expect(leaves.map(p => p.sessionId).sort()).toEqual(['duplicate', 'second-duplicate']);
    expect(leaves.find(p => p.id === layout.layoutState.focusedPaneId)?.sessionId).toBe('second-duplicate');
    expect(layout.layoutState.maximizedPaneId).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

it('keeps concurrent completions and fills placeholders without duplicate panes', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let layout!: ReturnType<typeof useWorkspaceLayout>;
  function Harness() { layout = useWorkspaceLayout(); return null; }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(createElement(Harness)));
    const onCreated = layout.openCreatedSession;
    act(() => { onCreated('a'); onCreated('b'); });
    expect(getLeaves(layout.layoutState.root).filter(p => p.sessionId).map(p => p.sessionId).sort()).toEqual(['a', 'b']);
    act(() => { onCreated('c'); onCreated('d'); onCreated('d'); });
    expect(getLeaves(layout.layoutState.root).map(p => p.sessionId).sort()).toEqual(['a', 'b', 'c', 'd']);
  } finally {
    await act(async () => root.unmount());
  }
});

it.each([false, true])('places a delayed creation in the current layout after Canvas changes from %s', async initialCanvas => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let layout!: ReturnType<typeof useWorkspaceLayout>;
  function Harness() { layout = useWorkspaceLayout(); return null; }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(createElement(Harness)));
    act(() => layout.setCanvasEnabled(initialCanvas));
    act(() => layout.openCreatedSession('original'));
    const onCreated = layout.openCreatedSession;
    act(() => layout.setCanvasEnabled(!initialCanvas));
    const inactiveRoot = initialCanvas ? layout.canvasState.panels : layout.splitLayoutState.root;
    act(() => onCreated('duplicate'));
    expect(getLeaves(layout.layoutState.root).map(p => p.sessionId)).toEqual(['duplicate']);
    expect(initialCanvas ? layout.canvasState.panels : layout.splitLayoutState.root).toBe(inactiveRoot);
  } finally {
    await act(async () => root.unmount());
  }
});

it('uses the current single-pane setting after a creation started with splitting enabled', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let layout!: ReturnType<typeof useWorkspaceLayout>;
  function Harness({ split }: { split: boolean }) { layout = useWorkspaceLayout(split); return null; }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(createElement(Harness, { split: true })));
    act(() => layout.openCreatedSession('original'));
    const onCreated = layout.openCreatedSession;
    await act(async () => root.render(createElement(Harness, { split: false })));
    act(() => onCreated('duplicate'));
    expect(getLeaves(layout.layoutState.root).map(p => p.sessionId)).toEqual(['duplicate']);
  } finally {
    await act(async () => root.unmount());
  }
});
