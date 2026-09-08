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
