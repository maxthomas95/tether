import type { LayoutNode, LayoutState } from '../../shared/layout-types';
import type { SavedCanvas } from '../../shared/canvas-types';
import type { RecipeSplitNode, WorkspaceRecipeLayout } from '../../shared/workspace-recipes';
import { canvasReducer, restoreCanvas, saveCanvas, type CanvasState } from './canvas-layout';
import { buildConstrainedLayout, clampMaxPanes, generatePaneId, getLeaves, isConstrainedLayout, normalizeToConstrained } from './layout-tree';

/** Indexes always refer to the selected sessions, never the whole runtime workspace. */
export function captureRecipeLayout(
  sessionIds: string[], activeSessionId: string | null,
  splitState: LayoutState, canvasState: CanvasState, canvasEnabled: boolean,
): WorkspaceRecipeLayout {
  function saveNode(node: LayoutNode | null): RecipeSplitNode | null {
    if (!node) return null;
    if (node.type === 'leaf') {
      const index = sessionIds.indexOf(node.sessionId ?? '');
      return { type: 'leaf', sessionIndex: index < 0 ? null : index };
    }
    return { type: 'split', direction: node.direction, ratio: node.ratio,
      children: [saveNode(node.children[0])!, saveNode(node.children[1])!] };
  }
  const canvas = saveCanvas(canvasState, sessionIds);
  if (canvas && (canvas.focusedSessionIndex ?? -1) < 0) canvas.focusedSessionIndex = null;
  return {
    mode: canvasEnabled ? 'canvas' : 'split',
    activeSessionIndex: Math.max(0, sessionIds.indexOf(activeSessionId ?? '')),
    split: saveNode(splitState.root),
    ...(canvas ? { canvas } : {}),
  };
}

/** Rebuild pane identities and respect the user's current pane limit. */
export function restoreRecipeSplit(layout: WorkspaceRecipeLayout, sessionIds: Array<string | null>, maxPanes: number) {
  function restoreNode(node: RecipeSplitNode | null): LayoutNode | null {
    if (!node) return null;
    if (node.type === 'leaf') return { type: 'leaf', id: generatePaneId(),
      sessionId: node.sessionIndex === null ? null : sessionIds[node.sessionIndex] ?? null };
    return { type: 'split', id: generatePaneId(), direction: node.direction, ratio: node.ratio,
      children: [restoreNode(node.children[0])!, restoreNode(node.children[1])!] };
  }
  let root = restoreNode(layout.split);
  const created = sessionIds.filter((id): id is string => id !== null);
  const activeId = sessionIds[layout.activeSessionIndex] ?? created[0];
  if (!getLeaves(root).some(leaf => leaf.sessionId)) {
    const fallbackIds = activeId ? [activeId, ...created.filter(id => id !== activeId)] : created;
    root = buildConstrainedLayout(fallbackIds.slice(0, clampMaxPanes(maxPanes)));
  }
  const preferredPaneId = getLeaves(root).find(leaf => leaf.sessionId === activeId)?.id;
  if (!isConstrainedLayout(root, maxPanes)) root = normalizeToConstrained(root, maxPanes, preferredPaneId);
  const leaves = getLeaves(root);
  return { root, focusedPaneId: leaves.find(leaf => leaf.sessionId === activeId)?.id
    ?? leaves.find(leaf => leaf.sessionId)?.id ?? null };
}

/** Saved geometry survives partial launches; selected background slots get usable panels. */
export function restoreRecipeCanvas(
  layout: WorkspaceRecipeLayout, sessionIds: Array<string | null>, viewport: CanvasState['viewport'],
): SavedCanvas {
  const created = sessionIds.filter((id): id is string => id !== null);
  let state = restoreCanvas(layout.canvas, sessionIds, viewport);
  const focusedSessionId = sessionIds[layout.activeSessionIndex] ?? created[0] ?? null;
  if (!state.initialized) {
    state = canvasReducer(state, { type: 'SEED', sessionIds: created, focusedSessionId });
  } else {
    const savedViewport = state.viewport;
    for (const id of created) if (!state.panels.some(panel => panel.sessionId === id)) {
      state = canvasReducer(state, { type: 'OPEN', sessionId: id });
    }
    state = canvasReducer(state, { type: 'PAN', x: savedViewport.x, y: savedViewport.y });
    const focusedPaneId = state.panels.find(panel => panel.sessionId === focusedSessionId)?.id;
    if (focusedPaneId) state = canvasReducer(state, { type: 'FOCUS_VISIBLE', paneId: focusedPaneId });
  }
  const focusedId = state.panels.find(panel => panel.id === state.focusedPaneId)?.sessionId;
  return {
    panels: state.panels.map(panel => ({ x: panel.x, y: panel.y, width: panel.width, height: panel.height,
      z: panel.z, sessionIndex: sessionIds.indexOf(panel.sessionId) })),
    viewport: { x: state.viewport.x, y: state.viewport.y },
    focusedSessionIndex: focusedId ? sessionIds.indexOf(focusedId) : null,
  };
}
