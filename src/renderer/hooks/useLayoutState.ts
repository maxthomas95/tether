import { useReducer } from 'react';
import type { LayoutNode, LayoutState, DropZone } from '../../shared/layout-types';
import {
  removePane,
  replaceSession,
  removeSessionFromTree,
  replaceSessionId,
  getLeaves,
  getLeafCount,
  findLeaf,
  addPaneConstrained,
  normalizeToConstrained,
  isConstrainedLayout,
  swapLeafSessions,
  clampMaxPanes,
  compactPlaceholders,
  generatePaneId,
} from '../lib/layout-tree';

export type LayoutAction =
  | { type: 'SET_ROOT'; root: LayoutNode | null }
  | { type: 'OPEN_SESSION'; sessionId: string; split: boolean }
  | { type: 'ADD_PANE'; targetPaneId: string; sessionId: string; zone: DropZone }
  | { type: 'REMOVE_PANE'; paneId: string }
  | { type: 'COMPACT_PLACEHOLDER'; paneId: string }
  | { type: 'REPLACE_SESSION'; paneId: string; sessionId: string }
  /** A restarted session takes over the panes of the one it replaces. */
  | { type: 'REPLACE_SESSION_ID'; fromSessionId: string; toSessionId: string }
  | { type: 'UPDATE_RATIO'; splitId: string; ratio: number }
  | { type: 'SET_FOCUS'; paneId: string | null }
  | { type: 'TOGGLE_MAXIMIZE'; paneId: string }
  | { type: 'REMOVE_SESSION'; sessionId: string }
  | { type: 'MOVE_PANE'; sourcePaneId: string; targetPaneId: string; zone: DropZone }
  | { type: 'SWAP_PANES'; sourcePaneId: string; targetPaneId: string }
  | { type: 'SET_MAX_PANES'; maxPanes: number };

export const initialLayoutState: LayoutState = {
  root: null,
  focusedPaneId: null,
  maximizedPaneId: null,
  maxPanes: 4,
};

/**
 * The focused pane must be on screen. While a pane is maximized every other
 * pane is hidden, so a focus that lands elsewhere (sidebar click, notification
 * click, pane-cycle and switch shortcuts, a newly added pane) drops the
 * maximize instead of leaving keystrokes going to one session while Stop and
 * Remove act on another.
 */
function keepFocusVisible(state: LayoutState): LayoutState {
  if (!state.maximizedPaneId || !state.focusedPaneId) return state;
  if (state.focusedPaneId === state.maximizedPaneId) return state;
  return { ...state, maximizedPaneId: null };
}

export function layoutReducer(state: LayoutState, action: LayoutAction): LayoutState {
  return keepFocusVisible(reduceLayout(state, action));
}

type ActionOf<T extends LayoutAction['type']> = Extract<LayoutAction, { type: T }>;

/** A maximized pane that is no longer in the tree stops being maximized. */
function survivingMaximize(state: LayoutState, root: LayoutNode | null): string | null {
  return root && state.maximizedPaneId && findLeaf(root, state.maximizedPaneId) ? state.maximizedPaneId : null;
}

/** Adopt a tree that lost panes, keeping focus and maximize on panes that still exist. */
function withReshapedRoot(state: LayoutState, root: LayoutNode | null, previousFocus: string | null): LayoutState {
  return {
    ...state,
    root,
    focusedPaneId: pickFocusPane(state.root, root, previousFocus),
    maximizedPaneId: survivingMaximize(state, root),
  };
}

function openSession(state: LayoutState, action: ActionOf<'OPEN_SESSION'>): LayoutState {
  const leaves = getLeaves(state.root);
  const existing = leaves.find(l => l.sessionId === action.sessionId);
  if (existing) return { ...state, focusedPaneId: existing.id, maximizedPaneId: null };
  if (!state.root) {
    const root: LayoutNode = { type: 'leaf', id: generatePaneId(), sessionId: action.sessionId };
    return { ...state, root, focusedPaneId: root.id, maximizedPaneId: null };
  }
  const focused = leaves.find(l => l.id === state.focusedPaneId) ?? leaves[0];
  const empty = focused.sessionId === null ? focused : leaves.find(l => l.sessionId === null);
  if (action.split && empty) {
    return { ...state, root: replaceSession(state.root, empty.id, action.sessionId),
      focusedPaneId: empty.id, maximizedPaneId: null };
  }
  if (!action.split || leaves.length >= state.maxPanes) {
    return { ...state, root: replaceSession(state.root, focused.id, action.sessionId),
      focusedPaneId: focused.id, maximizedPaneId: null };
  }
  const { root, newPaneId } = addPaneConstrained(state.root, action.sessionId, state.maxPanes, focused.id, 'right');
  return { ...state, root, focusedPaneId: newPaneId, maximizedPaneId: null };
}

function addPane(state: LayoutState, action: ActionOf<'ADD_PANE'>): LayoutState {
  // Prevent duplicate: don't add if session is already in a pane
  if (getLeaves(state.root).some(l => l.sessionId === action.sessionId)) return state;
  const { root: newRoot, newPaneId } = addPaneConstrained(
    state.root,
    action.sessionId,
    state.maxPanes,
    action.targetPaneId ?? state.focusedPaneId,
    action.zone,
  );
  if (newRoot === state.root) return state;
  return { ...state, root: newRoot, focusedPaneId: newPaneId };
}

function removePaneFromLayout(state: LayoutState, action: ActionOf<'REMOVE_PANE'>): LayoutState {
  const previousFocus = state.focusedPaneId === action.paneId ? null : state.focusedPaneId;
  const newRoot = normalizeToConstrained(removePane(state.root, action.paneId), state.maxPanes, previousFocus);
  return withReshapedRoot(state, newRoot, previousFocus);
}

function compactPlaceholder(state: LayoutState, action: ActionOf<'COMPACT_PLACEHOLDER'>): LayoutState {
  const newRoot = compactPlaceholders(state.root, action.paneId);
  if (newRoot === state.root) return state;
  return withReshapedRoot(state, newRoot, state.focusedPaneId === action.paneId ? null : state.focusedPaneId);
}

function replaceSessionIdInLayout(state: LayoutState, action: ActionOf<'REPLACE_SESSION_ID'>): LayoutState {
  if (!state.root) return state;
  const newRoot = replaceSessionId(state.root, action.fromSessionId, action.toSessionId);
  return newRoot === state.root ? state : { ...state, root: newRoot };
}

function toggleMaximize(state: LayoutState, action: ActionOf<'TOGGLE_MAXIMIZE'>): LayoutState {
  if (state.maximizedPaneId === action.paneId) return { ...state, maximizedPaneId: null };
  // Maximizing a pane focuses it, as in Canvas: otherwise the focus would
  // stay on a pane the maximize has just hidden.
  return { ...state, maximizedPaneId: action.paneId, focusedPaneId: action.paneId };
}

function movePane(state: LayoutState, action: ActionOf<'MOVE_PANE'>): LayoutState {
  if (!state.root || action.sourcePaneId === action.targetPaneId) return state;
  const sourceLeaf = findLeaf(state.root, action.sourcePaneId);
  const targetLeaf = findLeaf(state.root, action.targetPaneId);
  if (!sourceLeaf || !targetLeaf || sourceLeaf.sessionId === null) return state;

  if (getLeafCount(state.root) >= state.maxPanes) {
    const newRoot = swapLeafSessions(state.root, action.sourcePaneId, action.targetPaneId);
    return { ...state, root: newRoot, focusedPaneId: action.targetPaneId };
  }

  const afterRemove = removePane(state.root, action.sourcePaneId);
  if (!afterRemove) return state;
  const { root: newRoot, newPaneId } = addPaneConstrained(
    afterRemove,
    sourceLeaf.sessionId,
    state.maxPanes,
    action.targetPaneId,
    action.zone,
  );
  return { ...state, root: newRoot, focusedPaneId: newPaneId };
}

function swapPanes(state: LayoutState, action: ActionOf<'SWAP_PANES'>): LayoutState {
  if (!state.root || action.sourcePaneId === action.targetPaneId) return state;
  if (!findLeaf(state.root, action.sourcePaneId) || !findLeaf(state.root, action.targetPaneId)) return state;
  const newRoot = swapLeafSessions(state.root, action.sourcePaneId, action.targetPaneId);
  return newRoot === state.root ? state : { ...state, root: newRoot };
}

function removeSession(state: LayoutState, action: ActionOf<'REMOVE_SESSION'>): LayoutState {
  const removedRoot = removeSessionFromTree(state.root, action.sessionId);
  const newRoot = normalizeToConstrained(removedRoot, state.maxPanes, state.focusedPaneId);
  return withReshapedRoot(state, newRoot, state.focusedPaneId);
}

function setMaxPanes(state: LayoutState, action: ActionOf<'SET_MAX_PANES'>): LayoutState {
  const maxPanes = clampMaxPanes(action.maxPanes);
  const unchanged = state.maxPanes === maxPanes;
  if (!state.root) return unchanged ? state : { ...state, maxPanes };
  if (unchanged && isConstrainedLayout(state.root, maxPanes)) return state;

  const newRoot = normalizeToConstrained(state.root, maxPanes, state.focusedPaneId);
  return { ...withReshapedRoot(state, newRoot, state.focusedPaneId), maxPanes };
}

function reduceLayout(state: LayoutState, action: LayoutAction): LayoutState {
  switch (action.type) {
    case 'SET_ROOT':
      return { ...state, root: action.root };
    case 'OPEN_SESSION':
      return openSession(state, action);
    case 'ADD_PANE':
      return addPane(state, action);
    case 'REMOVE_PANE':
      return removePaneFromLayout(state, action);
    case 'COMPACT_PLACEHOLDER':
      return compactPlaceholder(state, action);
    case 'REPLACE_SESSION':
      return state.root ? { ...state, root: replaceSession(state.root, action.paneId, action.sessionId) } : state;
    case 'REPLACE_SESSION_ID':
      return replaceSessionIdInLayout(state, action);
    case 'SET_FOCUS':
      // Terminals re-announce focus on every mousedown; keep that a no-op.
      return state.focusedPaneId === action.paneId ? state : { ...state, focusedPaneId: action.paneId };
    case 'TOGGLE_MAXIMIZE':
      return toggleMaximize(state, action);
    case 'MOVE_PANE':
      return movePane(state, action);
    case 'SWAP_PANES':
      return swapPanes(state, action);
    case 'REMOVE_SESSION':
      return removeSession(state, action);
    case 'SET_MAX_PANES':
      return setMaxPanes(state, action);
    // UPDATE_RATIO is accepted for callers but constrained layouts have no free ratios.
    default:
      return state;
  }
}

function pickFocusPane(
  previousRoot: LayoutNode | null,
  nextRoot: LayoutNode | null,
  previousFocusedPaneId: string | null,
): string | null {
  if (!nextRoot) return null;

  const nextLeaves = getLeaves(nextRoot);
  if (nextLeaves.length === 0) return null;

  if (previousFocusedPaneId && nextLeaves.some(l => l.id === previousFocusedPaneId)) {
    return previousFocusedPaneId;
  }

  const previousFocusedLeaf = previousRoot && previousFocusedPaneId
    ? findLeaf(previousRoot, previousFocusedPaneId)
    : null;

  if (previousFocusedLeaf?.sessionId) {
    const sameSessionLeaf = nextLeaves.find(l => l.sessionId === previousFocusedLeaf.sessionId);
    if (sameSessionLeaf) return sameSessionLeaf.id;
  }

  if (previousFocusedLeaf?.sessionId === null) {
    const emptyLeaf = nextLeaves.find(l => l.sessionId === null);
    if (emptyLeaf) return emptyLeaf.id;
  }

  return nextLeaves.find(l => l.sessionId !== null)?.id ?? nextLeaves[0].id;
}

export function useLayoutState() {
  const [layoutState, layoutDispatch] = useReducer(layoutReducer, initialLayoutState);
  return { layoutState, layoutDispatch };
}
