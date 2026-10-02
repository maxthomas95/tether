import { expect, it } from 'vitest';
import type { LayoutState } from '../../shared/layout-types';
import type { WorkspaceRecipeLayout } from '../../shared/workspace-recipes';
import { canvasReducer, initialCanvasState } from './canvas-layout';
import { buildConstrainedLayout, getLeaves, isConstrainedLayout } from './layout-tree';
import { captureRecipeLayout, restoreRecipeCanvas, restoreRecipeSplit } from './workspace-recipes';

const layout: WorkspaceRecipeLayout = { mode: 'split', activeSessionIndex: 1, split: {
  type: 'split', direction: 'vertical', ratio: 0.5,
  children: [{ type: 'leaf', sessionIndex: 0 }, { type: 'leaf', sessionIndex: 1 }],
} };

it('captures selected slot indexes without live pane/session identifiers', () => {
  const root = buildConstrainedLayout(['excluded-live', 'selected-live'])!;
  const split: LayoutState = { root, focusedPaneId: null, maximizedPaneId: null, maxPanes: 4 };
  const canvas = canvasReducer(initialCanvasState, { type: 'SEED', sessionIds: ['excluded-live', 'selected-live'], focusedSessionId: 'excluded-live' });
  const saved = captureRecipeLayout(['selected-live'], 'excluded-live', split, canvas, true);
  expect(saved.mode).toBe('canvas');
  expect(saved.activeSessionIndex).toBe(0);
  expect(saved.split).toMatchObject({ children: [{ sessionIndex: null }, { sessionIndex: 0 }] });
  expect(saved.canvas?.panels).toHaveLength(1);
  expect(saved.canvas?.panels[0].sessionIndex).toBe(0);
  expect(saved.canvas?.focusedSessionIndex).toBeNull();
  expect(JSON.stringify(saved)).not.toContain('live');
  expect(captureRecipeLayout(['selected-live'], 'selected-live', { ...split, root: null }, initialCanvasState, false)).toEqual({
    mode: 'split', activeSessionIndex: 0, split: null,
  });
});

it('retains split direction, ratio and focus while allocating fresh pane identities', () => {
  const first = restoreRecipeSplit(layout, ['fresh-a', 'fresh-b'], 4);
  const second = restoreRecipeSplit(layout, ['fresh-a', 'fresh-b'], 4);
  expect(first.root).toMatchObject({ direction: 'vertical', ratio: 0.5 });
  expect(getLeaves(first.root).map(leaf => leaf.sessionId)).toEqual(['fresh-a', 'fresh-b']);
  expect(getLeaves(first.root).find(leaf => leaf.id === first.focusedPaneId)?.sessionId).toBe('fresh-b');
  expect(first.root?.id).not.toBe(second.root?.id);
});

it('normalizes legacy split ratios to the existing equal-pane policy', () => {
  const legacy = { ...layout, split: { ...layout.split!, ratio: 0.35 } } as WorkspaceRecipeLayout;
  const restored = restoreRecipeSplit(legacy, ['fresh-a', 'fresh-b'], 4);
  expect(restored.root).toMatchObject({ direction: 'vertical', ratio: 0.5 });
  expect(isConstrainedLayout(restored.root, 4)).toBe(true);
});

it('respects current pane limits and keeps the preferred session after shrinking', () => {
  const restored = restoreRecipeSplit(layout, ['fresh-a', 'fresh-b'], 1);
  expect(isConstrainedLayout(restored.root, 1)).toBe(true);
  expect(getLeaves(restored.root).map(leaf => leaf.sessionId)).toEqual(['fresh-b']);
  expect(restored.focusedPaneId).toBe(restored.root?.id);
});

it('maps failures to empty slots, and provides a usable fallback for selected background sessions', () => {
  const partial = restoreRecipeSplit(layout, [null, 'fresh-b'], 4);
  expect(getLeaves(partial.root).map(leaf => leaf.sessionId)).toEqual([null, 'fresh-b']);
  const background = restoreRecipeSplit({ ...layout, split: null }, ['fresh-a', 'fresh-b'], 1);
  expect(getLeaves(background.root)[0].sessionId).toBe('fresh-b');
  expect(restoreRecipeSplit(layout, [null, null], 4).focusedPaneId).toBeNull();
});

it('keeps successful Canvas geometry and viewport and supplies panels for missing selected slots', () => {
  const saved: WorkspaceRecipeLayout = { ...layout, mode: 'canvas', activeSessionIndex: 0, canvas: {
    panels: [{ sessionIndex: 0, x: 50, y: 60, width: 500, height: 400, z: 3 },
      { sessionIndex: 1, x: 700, y: 60, width: 500, height: 400, z: 4 }],
    viewport: { x: 20, y: 30 }, focusedSessionIndex: 0,
  } };
  const restored = restoreRecipeCanvas(saved, ['fresh-a', null, 'background'], initialCanvasState.viewport);
  expect(restored.panels).toHaveLength(2);
  expect(restored.panels[0]).toMatchObject({ sessionIndex: 0, x: 50, y: 60, width: 500, height: 400 });
  expect(restored.panels[1].sessionIndex).toBe(2);
  expect(restored.viewport).toEqual({ x: 20, y: 30 });
  expect(restored.focusedSessionIndex).toBe(0);
});

it('creates usable Canvas panels without saved geometry and handles an empty result', () => {
  const restored = restoreRecipeCanvas(layout, ['fresh-a', 'fresh-b'], initialCanvasState.viewport);
  expect(restored.panels.map(panel => panel.sessionIndex)).toEqual([0, 1]);
  expect(restored.focusedSessionIndex).toBe(1);
  expect(restored.panels.every(panel => panel.width >= 280 && panel.height >= 180)).toBe(true);
  expect(restoreRecipeCanvas(layout, [null, null], initialCanvasState.viewport).panels).toEqual([]);
});
