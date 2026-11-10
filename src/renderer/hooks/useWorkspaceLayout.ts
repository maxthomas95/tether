import { useCallback, useMemo, useReducer, useRef, useState } from 'react';
import { useLayoutState, type LayoutAction } from './useLayoutState';
import { canvasLayoutState, canvasReducer, initialCanvasState } from '../lib/canvas-layout';

/** Keep each layout intact while presenting the existing pane actions to App. */
export function useWorkspaceLayout(enablePaneSplitting = true) {
  const { layoutState: splitLayoutState, layoutDispatch: splitDispatch } = useLayoutState();
  const [canvasState, canvasDispatch] = useReducer(canvasReducer, initialCanvasState);
  const [canvasEnabled, setCanvasEnabled] = useState(false);
  const modeRef = useRef({ canvasEnabled, enablePaneSplitting });
  modeRef.current = { canvasEnabled, enablePaneSplitting };
  const canvasLayout = useMemo(() => canvasLayoutState(canvasState), [canvasState]);
  const layoutDispatch = useCallback((action: LayoutAction) => {
    // A session can be mounted in both arrangements; removing or replacing
    // it applies to both, whichever one is showing.
    if (action.type === 'REMOVE_SESSION' || action.type === 'REPLACE_SESSION_ID') {
      splitDispatch(action);
      canvasDispatch(action);
    } else if (modeRef.current.canvasEnabled) {
      canvasDispatch(action);
    } else {
      splitDispatch(action);
    }
  }, []);
  // A creation callback may be held across a slow SSH/Vault IPC call. Choose
  // the current mode here and let its reducer choose a current pane atomically.
  const openCreatedSession = useCallback((sessionId: string) => {
    layoutDispatch({ type: 'OPEN_SESSION', sessionId, split: modeRef.current.enablePaneSplitting });
  }, [layoutDispatch]);
  return {
    layoutState: canvasEnabled ? canvasLayout : splitLayoutState,
    layoutDispatch, splitLayoutState, splitDispatch,
    canvasState, canvasDispatch, canvasEnabled, setCanvasEnabled, openCreatedSession,
  };
}
