import { useReducer } from 'react';
import type { LayoutNode, LayoutState, DropZone } from '../../shared/layout-types';
import {
  addPane,
  removePane,
  replaceSession,
  updateRatio,
  removeSessionFromTree,
} from '../lib/layout-tree';

export type LayoutAction =
  | { type: 'SET_ROOT'; root: LayoutNode | null }
  | { type: 'ADD_PANE'; targetPaneId: string; sessionId: string; zone: DropZone }
  | { type: 'REMOVE_PANE'; paneId: string }
  | { type: 'REPLACE_SESSION'; paneId: string; sessionId: string }
  | { type: 'UPDATE_RATIO'; splitId: string; ratio: number }
  | { type: 'SET_FOCUS'; paneId: string | null }
  | { type: 'TOGGLE_MAXIMIZE'; paneId: string }
  | { type: 'REMOVE_SESSION'; sessionId: string };

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
