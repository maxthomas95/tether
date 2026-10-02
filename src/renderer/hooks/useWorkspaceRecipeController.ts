import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionInfo } from '../../shared/types';
import type { LayoutState } from '../../shared/layout-types';
import type { SavedCanvas } from '../../shared/canvas-types';
import type { WorkspaceRecipeLaunchResult, WorkspaceRecipeOpenPlan } from '../../shared/workspace-recipes';
import type { CanvasState } from '../lib/canvas-layout';
import { captureRecipeLayout, restoreRecipeCanvas, restoreRecipeSplit } from '../lib/workspace-recipes';
import { useWorkspaceRecipeLauncher } from './useWorkspaceRecipeLauncher';

export interface OpenedWorkspaceRecipeLayout {
  mode: 'split' | 'canvas';
  split: ReturnType<typeof restoreRecipeSplit>;
  canvas: SavedCanvas;
  sessionIds: Array<string | null>;
}
interface Inputs {
  activeSessionId: string | null;
  splitState: LayoutState;
  canvasState: CanvasState;
  canvasEnabled: boolean;
  maxPanes: number;
  registerSession(session: SessionInfo): void;
  requestVaultLogin(reason?: string): Promise<boolean>;
  applyLayout(layout: OpenedWorkspaceRecipeLayout): void;
  focusPane(paneId: string): void;
  notifyError(title: string, error: unknown): void;
}
/** Closing cancels future starts; only finishing intentionally replaces the visible layout. */
export function useWorkspaceRecipeController(inputs: Inputs) {
  const inputsRef = useRef(inputs);
  inputsRef.current = inputs;
  const launcher = useWorkspaceRecipeLauncher(inputs);
  const [isOpen, setOpen] = useState(false);
  const openRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; openRef.current = false; };
  }, []);

  const apply = useCallback((plan: WorkspaceRecipeOpenPlan, result: WorkspaceRecipeLaunchResult) => {
    if (!mounted.current || !result.sessionIds.some(id => id !== null)) return;
    const current = inputsRef.current;
    const split = restoreRecipeSplit(plan.layout, result.sessionIds, current.maxPanes);
    const canvas = restoreRecipeCanvas(plan.layout, result.sessionIds, current.canvasState.viewport);
    current.applyLayout({ mode: plan.layout.mode, split, canvas, sessionIds: result.sessionIds });
    void window.electronAPI.config.set('sessionLayoutMode', plan.layout.mode)
      .catch(error => inputsRef.current.notifyError('Could not save the layout mode', error));
    const canvasFocus = canvas.focusedSessionIndex === null ? null : result.sessionIds[canvas.focusedSessionIndex];
    const paneId = plan.layout.mode === 'canvas' ? canvasFocus && `canvas-${canvasFocus}` : split.focusedPaneId;
    if (paneId) requestAnimationFrame(() => requestAnimationFrame(() => {
      if (mounted.current && !openRef.current) inputsRef.current.focusPane(paneId);
    }));
  }, []);
  const open = useCallback(() => {
    if (launcher.busy) return;
    openRef.current = true;
    setOpen(true);
  }, [launcher.busy]);
  const close = useCallback(() => {
    launcher.cancel();
    openRef.current = false;
    setOpen(false);
  }, [launcher.cancel]);
  const capture = useCallback((name: string, sessionIds: string[]) => {
    const current = inputsRef.current;
    return window.electronAPI.workspaceRecipes.capture({ name, sessionIds,
      layout: captureRecipeLayout(sessionIds, current.activeSessionId, current.splitState, current.canvasState, current.canvasEnabled) });
  }, []);
  const finish = useCallback((plan: WorkspaceRecipeOpenPlan, result: WorkspaceRecipeLaunchResult) => {
    launcher.cancel();
    openRef.current = false;
    setOpen(false);
    apply(plan, result);
  }, [launcher.cancel, apply]);
  return { isOpen, busy: launcher.busy, open, close, capture, launch: launcher.launch, finish, cancel: launcher.cancel };
}
