import { useCallback, useMemo, useReducer, useState } from 'react';
import { useLayoutState, type LayoutAction } from './useLayoutState';
import { canvasLayoutState, canvasReducer, initialCanvasState } from '../lib/canvas-layout';

/** Keep each layout intact while presenting the existing pane actions to App. */
export function useWorkspaceLayout() {
  const { layoutState: splitLayoutState, layoutDispatch: splitDispatch } = useLayoutState();
  const [canvasState, canvasDispatch] = useReducer(canvasReducer, initialCanvasState);
  const [canvasEnabled, setCanvasEnabled] = useState(false);
  const canvasLayout = useMemo(() => canvasLayoutState(canvasState), [canvasState]);
  const layoutDispatch = useCallback((action: LayoutAction) => {
    if (action.type === 'REMOVE_SESSION') {
      splitDispatch(action);
      canvasDispatch(action);
    } else if (canvasEnabled) {
      canvasDispatch(action);
    } else {
      splitDispatch(action);
    }
  }, [canvasEnabled]);
  return {
    layoutState: canvasEnabled ? canvasLayout : splitLayoutState,
    layoutDispatch, splitLayoutState, splitDispatch,
    canvasState, canvasDispatch, canvasEnabled, setCanvasEnabled,
  };
}
