import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChildAgentInfo, ChildAgentList } from '../../shared/child-agents';
import {
  CHILD_AGENT_PANEL_DEFAULT_WIDTH,
  CHILD_AGENT_PANEL_WIDTH_CONFIG_KEY,
  parseSavedChildAgentPanelWidth,
} from '../utils/child-agent-panel';

export interface ViewedChildAgent {
  sessionId: string;
  /** The row as the sidebar shows it now, not as it was when the panel opened. */
  agent: ChildAgentInfo;
  /** Opened from the keyboard, so the panel takes focus. */
  focusOnOpen: boolean;
}

export interface ChildAgentViewerState {
  /** What the docked panel shows; null while it is closed. */
  viewed: ViewedChildAgent | null;
  width: number;
  /** Open the panel on a row, swap it to another row, or close it from the row it shows. */
  toggle(sessionId: string, agent: ChildAgentInfo, viaKeyboard?: boolean): void;
  /** `restoreFocus` puts focus back on the row that opened the panel. */
  close(restoreFocus?: boolean): void;
  setWidth(width: number): void;
  saveWidth(width: number): void;
}

/**
 * State of the docked subagent panel: which row it shows and how wide it is.
 * The panel follows the sidebar's lists, so it closes when its session is
 * removed or subagent rows are turned off.
 */
export function useChildAgentViewer(
  lists: ReadonlyMap<string, ChildAgentList>,
  onSaveError?: (error: unknown) => void,
): ChildAgentViewerState {
  const [target, setTarget] = useState<ViewedChildAgent | null>(null);
  const [width, setWidth] = useState(CHILD_AGENT_PANEL_DEFAULT_WIDTH);
  const opener = useRef<HTMLElement | null>(null);
  const saveErrorRef = useRef(onSaveError);
  saveErrorRef.current = onSaveError;

  useEffect(() => {
    let cancelled = false;
    Promise.resolve(window.electronAPI.config.get(CHILD_AGENT_PANEL_WIDTH_CONFIG_KEY)).then(value => {
      const saved = parseSavedChildAgentPanelWidth(value);
      if (!cancelled && saved !== null) setWidth(saved);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const list = target ? lists.get(target.sessionId) : undefined;

  useEffect(() => {
    if (target && !list) setTarget(null);
  }, [target, list]);

  const viewed = useMemo<ViewedChildAgent | null>(() => {
    if (!target || !list) return null;
    const live = list.agents.find(a => a.id === target.agent.id);
    if (live) return { ...target, agent: live };
    // No longer listed (the pane moved to another conversation, or the row aged
    // out), so nothing will report its end: stop presenting it as running.
    return target.agent.state === 'running' ? { ...target, agent: { ...target.agent, state: 'done' } } : target;
  }, [target, list]);

  const toggle = useCallback((sessionId: string, agent: ChildAgentInfo, viaKeyboard = false) => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setTarget(prev => (prev?.sessionId === sessionId && prev.agent.id === agent.id
      ? null
      : { sessionId, agent, focusOnOpen: viaKeyboard }));
  }, []);

  const close = useCallback((restoreFocus = false) => {
    setTarget(null);
    if (restoreFocus && opener.current?.isConnected) opener.current.focus();
    opener.current = null;
  }, []);

  const saveWidth = useCallback((next: number) => {
    Promise.resolve(window.electronAPI.config.set(CHILD_AGENT_PANEL_WIDTH_CONFIG_KEY, String(next)))
      .catch(error => saveErrorRef.current?.(error));
  }, []);

  return { viewed, width, toggle, close, setWidth, saveWidth };
}
