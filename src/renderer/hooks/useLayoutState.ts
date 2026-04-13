import { useReducer } from 'react';
import type { LayoutNode, LayoutState, DropZone } from '../../shared/layout-types';
import {
  removePane,
  replaceSession,
  removeSessionFromTree,
  getLeaves,
  getLeafCount,
  findLeaf,
  addPaneConstrained,
  normalizeToConstrained,
  isConstrainedLayout,
  swapLeafSessions,
  clampMaxPanes,
} from '../lib/layout-tree';

export type LayoutAction =
  | { type: 'SET_ROOT'; root: LayoutNode | null }
  | { type: 'ADD_PANE'; targetPaneId: string; sessionId: string; zone: DropZone }
  | { type: 'REMOVE_PANE'; paneId: string }
  | { type: 'REPLACE_SESSION'; paneId: string; sessionId: string }
  | { type: 'UPDATE_RATIO'; splitId: string; ratio: number }
  | { type: 'SET_FOCUS'; paneId: string | null }
  | { type: 'TOGGLE_MAXIMIZE'; paneId: string }
  | { type: 'REMOVE_SESSION'; sessionId: string }
  | { type: 'MOVE_PANE'; sourcePaneId: string; targetPaneId: string; zone: DropZone }
  | { type: 'SET_MAX_PANES'; maxPanes: number };

const initialState: LayoutState = {
  root: null,
  focusedPaneId: null,
  maximizedPaneId: null,
  maxPanes: 4,
};

function layoutReducer(state: LayoutState, action: LayoutAction): LayoutState {
  switch (action.type) {
    case 'SET_ROOT':
      return { ...state, root: action.root };

    case 'ADD_PANE': {
      // Prevent duplicate: don't add if session is already in a pane
      if (state.root) {
        const leaves = getLeaves(state.root);
        if (leaves.some(l => l.sessionId === action.sessionId)) return state;
      }
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

    case 'REMOVE_PANE': {
      const removedRoot = removePane(state.root, action.paneId);
      const newRoot = normalizeToConstrained(
        removedRoot,
        state.maxPanes,
        state.focusedPaneId === action.paneId ? null : state.focusedPaneId,
      );
      const focused = pickFocusPane(state.root, newRoot, state.focusedPaneId === action.paneId ? null : state.focusedPaneId);
      const maximized = newRoot && state.maximizedPaneId && findLeaf(newRoot, state.maximizedPaneId)
        ? state.maximizedPaneId
        : null;
      return { ...state, root: newRoot, focusedPaneId: focused, maximizedPaneId: maximized };
    }

    case 'REPLACE_SESSION': {
      if (!state.root) return state;
      const newRoot = replaceSession(state.root, action.paneId, action.sessionId);
      return { ...state, root: newRoot };
    }

    case 'UPDATE_RATIO': {
      return state;
    }

    case 'SET_FOCUS':
      return { ...state, focusedPaneId: action.paneId };

    case 'TOGGLE_MAXIMIZE': {
      const maximized = state.maximizedPaneId === action.paneId ? null : action.paneId;
      return { ...state, maximizedPaneId: maximized };
    }

    case 'MOVE_PANE': {
      if (!state.root) return state;
      if (action.sourcePaneId === action.targetPaneId) return state;
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

    case 'REMOVE_SESSION': {
      const removedRoot = removeSessionFromTree(state.root, action.sessionId);
      const newRoot = normalizeToConstrained(removedRoot, state.maxPanes, state.focusedPaneId);
      const focused = pickFocusPane(state.root, newRoot, state.focusedPaneId);
      const maximized = newRoot && state.maximizedPaneId && findLeaf(newRoot, state.maximizedPaneId)
        ? state.maximizedPaneId
        : null;
      return { ...state, root: newRoot, focusedPaneId: focused, maximizedPaneId: maximized };
    }

    case 'SET_MAX_PANES': {
      const maxPanes = clampMaxPanes(action.maxPanes);
      if (!state.root) {
        return state.maxPanes === maxPanes ? state : { ...state, maxPanes };
      }

      if (state.maxPanes === maxPanes && isConstrainedLayout(state.root, maxPanes)) {
        return state;
      }

      const newRoot = normalizeToConstrained(state.root, maxPanes, state.focusedPaneId);
      const focused = pickFocusPane(state.root, newRoot, state.focusedPaneId);
      const maximized = newRoot && state.maximizedPaneId && findLeaf(newRoot, state.maximizedPaneId)
        ? state.maximizedPaneId
        : null;
      return { ...state, root: newRoot, focusedPaneId: focused, maximizedPaneId: maximized, maxPanes };
    }

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
  const [layoutState, layoutDispatch] = useReducer(layoutReducer, initialState);
  return { layoutState, layoutDispatch };
}
