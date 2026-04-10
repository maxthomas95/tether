import { useReducer } from 'react';
import type { LayoutNode, LayoutState, DropZone } from '../../shared/layout-types';
import {
  addPane,
  removePane,
  replaceSession,
  updateRatio,
  removeSessionFromTree,
  getLeaves,
  findLeaf,
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
  | { type: 'MOVE_PANE'; sourcePaneId: string; targetPaneId: string; zone: DropZone };

const initialState: LayoutState = {
  root: null,
  focusedPaneId: null,
  maximizedPaneId: null,
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
      const newRoot = addPane(state.root, action.targetPaneId, action.sessionId, action.zone);
      return { ...state, root: newRoot };
    }

    case 'REMOVE_PANE': {
      const newRoot = removePane(state.root, action.paneId);
      let focused = state.focusedPaneId;
      let maximized = state.maximizedPaneId;
      if (focused === action.paneId) focused = null;
      if (maximized === action.paneId) maximized = null;
      return { ...state, root: newRoot, focusedPaneId: focused, maximizedPaneId: maximized };
    }

    case 'REPLACE_SESSION': {
      if (!state.root) return state;
      const newRoot = replaceSession(state.root, action.paneId, action.sessionId);
      return { ...state, root: newRoot };
    }

    case 'UPDATE_RATIO': {
      if (!state.root) return state;
      const newRoot = updateRatio(state.root, action.splitId, action.ratio);
      return { ...state, root: newRoot };
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
      if (!sourceLeaf) return state;
      const afterRemove = removePane(state.root, action.sourcePaneId);
      if (!afterRemove) return state;
      const newRoot = addPane(afterRemove, action.targetPaneId, sourceLeaf.sessionId, action.zone);
      const newLeaves = getLeaves(newRoot);
      const oldLeaves = getLeaves(afterRemove);
      const newLeaf = newLeaves.find(l => !oldLeaves.some(o => o.id === l.id));
      return { ...state, root: newRoot, focusedPaneId: newLeaf?.id ?? state.focusedPaneId };
    }

    case 'REMOVE_SESSION': {
      const newRoot = removeSessionFromTree(state.root, action.sessionId);
      let focused = state.focusedPaneId;
      let maximized = state.maximizedPaneId;
      if (!newRoot) {
        focused = null;
        maximized = null;
      }
      return { ...state, root: newRoot, focusedPaneId: focused, maximizedPaneId: maximized };
    }

    default:
      return state;
  }
}

export function useLayoutState() {
  const [layoutState, layoutDispatch] = useReducer(layoutReducer, initialState);
  return { layoutState, layoutDispatch };
}
