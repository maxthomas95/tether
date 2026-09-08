import { describe, expect, it } from 'vitest';
import {
  adjacentCanvasPanel, canvasReducer, initialCanvasState, saveCanvas, restoreCanvas,
  visibleCanvasPanels, type CanvasState,
} from './canvas-layout';

function seed(count = 6): CanvasState {
  return canvasReducer(initialCanvasState, {
    type: 'SEED', sessionIds: Array.from({ length: count }, (_, i) => `s${i}`), focusedSessionId: 's0',
  });
}

describe('session canvas', () => {
  it('opens more than the split limit without replacing or duplicating sessions', () => {
    const state = seed(12);
    const selected = canvasReducer(state, { type: 'OPEN', sessionId: 's7' });
    expect(selected.panels).toHaveLength(12);
    expect(selected.focusedPaneId).toBe('canvas-s7');
    expect(selected.panels.find(p => p.sessionId === 's7')!.z).toBeGreaterThan(state.panels.at(-1)!.z);
  });

  it('preserves geometry and camera across maximize and restore', () => {
    const state = canvasReducer(seed(), { type: 'PAN', x: -70, y: 35 });
    const maximized = canvasReducer(state, { type: 'TOGGLE_MAXIMIZE', paneId: 'canvas-s0' });
    expect(visibleCanvasPanels(maximized).map(p => p.sessionId)).toEqual(['s0']);
    const restored = canvasReducer(maximized, { type: 'TOGGLE_MAXIMIZE', paneId: 'canvas-s0' });
    expect(restored.panels).toEqual(state.panels);
    expect(restored.viewport).toEqual(state.viewport);
  });

  it('reveals a selected offscreen session and exits a different maximized panel', () => {
    let state = seed();
    state = canvasReducer(state, { type: 'RECT', paneId: 'canvas-s5', rect: { x: 5000, y: -3000, width: 600, height: 400 } });
    state = canvasReducer(state, { type: 'TOGGLE_MAXIMIZE', paneId: 'canvas-s0' });
    const selected = canvasReducer(state, { type: 'OPEN', sessionId: 's5' });
    expect(selected.maximizedPaneId).toBeNull();
    expect(visibleCanvasPanels(selected).map(p => p.sessionId)).toContain('s5');
  });

  it('does not move the canvas when clicking a partly visible terminal', () => {
    const state = canvasReducer(seed(), { type: 'PAN', x: 100, y: 100 });
    const selected = canvasReducer(state, { type: 'FOCUS_VISIBLE', paneId: 'canvas-s0' });
    expect(selected.viewport).toEqual(state.viewport);
    expect(canvasReducer(selected, { type: 'FOCUS_VISIBLE', paneId: 'canvas-s0' })).toBe(selected);
  });

  it('keeps offscreen panels out of the rendered list and restores them when panning back', () => {
    const state = seed();
    const panned = canvasReducer(state, { type: 'PAN', x: 9000, y: 9000 });
    expect(visibleCanvasPanels(panned)).toHaveLength(0);
    const returned = canvasReducer(panned, { type: 'PAN', x: 0, y: 0 });
    expect(visibleCanvasPanels(returned)).toHaveLength(6);
    expect(returned.panels).toEqual(state.panels);
  });

  it('uses panel positions for directional keyboard focus', () => {
    const state = seed(4);
    expect(adjacentCanvasPanel(state, 'right')).toBe('canvas-s1');
    expect(adjacentCanvasPanel(state, 'down')).toBe('canvas-s3');
    expect(adjacentCanvasPanel(state, 'left')).toBeNull();
  });

  it('detaches a fully covered panel and reveals it when selected', () => {
    let state = seed(3);
    const rects = [
      { x: 16, y: 16, width: 560, height: 200 },
      { x: 16, y: 16, width: 280, height: 200 },
      { x: 296, y: 16, width: 280, height: 200 },
    ];
    rects.forEach((rect, i) => { state = canvasReducer(state, { type: 'RECT', paneId: `canvas-s${i}`, rect }); });
    state = canvasReducer(state, { type: 'SET_FOCUS', paneId: 'canvas-s1' });
    state = canvasReducer(state, { type: 'SET_FOCUS', paneId: 'canvas-s2' });
    expect(visibleCanvasPanels(state).map(p => p.sessionId)).toEqual(['s1', 's2']);
    state = canvasReducer(state, { type: 'OPEN', sessionId: 's0' });
    expect(visibleCanvasPanels(state).map(p => p.sessionId)).toEqual(['s0']);
  });

  it('preserves a restarted session slot and removes deleted sessions', () => {
    const state = seed();
    const restarted = canvasReducer(state, { type: 'REPLACE_SESSION', paneId: 'canvas-s2', sessionId: 'fresh' });
    expect(restarted.panels[2]).toEqual({ ...state.panels[2], sessionId: 'fresh' });
    const pruned = canvasReducer(restarted, { type: 'PRUNE', sessionIds: ['s0', 'fresh'] });
    expect(pruned.panels.map(p => p.sessionId)).toEqual(['s0', 'fresh']);
    expect(canvasReducer(pruned, { type: 'OPEN', sessionId: 'fresh' }).panels).toHaveLength(2);
  });

  it('does not reopen closed panels when switching modes', () => {
    const state = canvasReducer(seed(), { type: 'REMOVE_PANE', paneId: 'canvas-s2' });
    expect(canvasReducer(state, { type: 'SEED', sessionIds: ['s0', 's1', 's2'], focusedSessionId: 's0' })).toBe(state);
  });

  it('allocates a unique panel when a swapped session is closed and reopened', () => {
    let state = canvasReducer(seed(2), { type: 'SWAP_PANES', sourcePaneId: 'canvas-s0', targetPaneId: 'canvas-s1' });
    state = canvasReducer(state, { type: 'REMOVE_PANE', paneId: 'canvas-s0' });
    state = canvasReducer(state, { type: 'OPEN', sessionId: 's1' });
    expect(new Set(state.panels.map(p => p.id)).size).toBe(2);
    expect(new Set(state.panels.map(p => p.sessionId))).toEqual(new Set(['s0', 's1']));
    expect(state.panels.find(p => p.id === state.focusedPaneId)?.sessionId).toBe('s1');
  });

  it('restores panels against saved session indexes despite failed session restores', () => {
    const state = seed(3);
    const saved = saveCanvas(state, ['s2', 's0', 's1'])!;
    const restored = restoreCanvas(saved, ['new-s2', null, 'new-s1']);
    expect(restored.panels.map(p => p.sessionId)).toEqual(['new-s1', 'new-s2']);
    expect(restored.panels.find(p => p.sessionId === 'new-s2')).toMatchObject({ x: state.panels[2].x, width: state.panels[2].width });
  });

  it('round trips camera, order, focus and rectangles with new runtime session IDs', () => {
    const state = canvasReducer(seed(3), { type: 'PAN', x: -50, y: 90 });
    const restored = restoreCanvas(saveCanvas(state, ['s0', 's1', 's2']), ['a', 'b', 'c']);
    expect(restored.viewport).toEqual(state.viewport);
    expect(restored.focusedPaneId).toBe('canvas-a');
    expect(restored.panels.map(({ sessionId: _sessionId, id: _id, ...rect }) => rect))
      .toEqual(state.panels.map(({ sessionId: _sessionId, id: _id, ...rect }) => rect));
  });

  it('ignores duplicate/missing saved sessions and bounds invalid geometry', () => {
    const panel = { sessionIndex: 0, x: Infinity, y: NaN, width: -1, height: 0, z: 0 };
    const restored = restoreCanvas({ panels: [panel, panel, { ...panel, sessionIndex: 99 }],
      viewport: { x: NaN, y: Infinity }, focusedSessionIndex: 99 }, ['s0']);
    expect(restored.panels).toHaveLength(1);
    expect(restored.panels[0].width).toBe(280);
    expect(restored.panels[0].height).toBe(180);
    expect(Number.isFinite(restored.viewport.x)).toBe(true);
    expect(restored.focusedPaneId).toBe('canvas-s0');
  });
});
