import { useRef, useEffect, useCallback } from 'react';
import '@xterm/xterm/css/xterm.css';
import type { SessionInfo, SessionState } from '../../shared/types';
import type { TerminalManagerAPI } from '../hooks/useTerminalManager';
import type { LayoutAction } from '../hooks/useLayoutState';
import { DropZoneOverlay } from './DropZoneOverlay';
import { CliToolBadge } from './CliToolBadge';
import { PaneStatusStrip } from './PaneStatusStrip';

interface TerminalPaneProps {
  paneId: string;
  sessionId: string | null;
  session: SessionInfo | undefined;
  isFocused: boolean;
  isDragging: boolean;
  draggingPaneId: string | null;
  onDragStateChange: (dragging: boolean, sourcePaneId?: string) => void;
  layoutDispatch: React.Dispatch<LayoutAction>;
  termManager: TerminalManagerAPI;
  enablePaneSplitting: boolean;
  currentLeafCount: number;
  maxPanes: number;
}

export function TerminalPane({
  paneId,
  sessionId,
  session,
  isFocused,
  isDragging,
  draggingPaneId,
  onDragStateChange,
  layoutDispatch,
  termManager,
  enablePaneSplitting,
  currentLeafCount,
  maxPanes,
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const isPlaceholder = sessionId === null;

  // Mount terminal into container
  useEffect(() => {
    const container = containerRef.current;
    if (!container || sessionId === null) {
      termManager.detachPane(paneId);
      return;
    }

    termManager.attachToPane(paneId, sessionId, container);

    return () => {
      termManager.detachPane(paneId);
    };
  }, [paneId, sessionId, termManager]);

  // ResizeObserver for auto-fitting
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleResize = () => {
      requestAnimationFrame(() => {
        termManager.fitPane(paneId);
      });
    };

    observerRef.current = new ResizeObserver(handleResize);
    observerRef.current.observe(container);

    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, [paneId, termManager]);

  // Window resize fallback
  useEffect(() => {
    const handleResize = () => {
      requestAnimationFrame(() => {
        termManager.fitPane(paneId);
      });
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [paneId, termManager]);

  // Listen for focus events on the container to set focus in layout
  const handleFocus = useCallback(() => {
    layoutDispatch({ type: 'SET_FOCUS', paneId });
  }, [paneId, layoutDispatch]);

  const handleClose = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    layoutDispatch({ type: 'REMOVE_PANE', paneId });
  }, [paneId, layoutDispatch]);

  const handleMaximize = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    layoutDispatch({ type: 'TOGGLE_MAXIMIZE', paneId });
  }, [paneId, layoutDispatch]);

  const label = session?.label || 'Session';
  const path = session ? abbreviatePath(session.workingDir) : '';
  const headerLabel = isPlaceholder ? 'Empty pane' : label;
  const headerPath = isPlaceholder ? '' : path;
  const canDragPane = enablePaneSplitting && sessionId !== null;

  return (
    <div
      className={`terminal-pane ${isFocused && enablePaneSplitting ? 'terminal-pane--focused' : ''}`}
      onFocus={handleFocus}
      onMouseDown={handleFocus}
    >
      <div
        className="terminal-pane-header"
        style={canDragPane ? undefined : { cursor: 'default' }}
        draggable={canDragPane}
        onDragStart={(e) => {
          if (!canDragPane) return;
          e.dataTransfer.setData('application/tether-pane', paneId);
          e.dataTransfer.setData('application/tether-session', sessionId);
          e.dataTransfer.effectAllowed = 'move';
          onDragStateChange(true, paneId);
        }}
        onDragEnd={() => onDragStateChange(false)}
      >
        <span className={`status-dot status-dot--${getStatusClass(session?.state)}`} />
        {session && <CliToolBadge session={session} />}
        <span className="terminal-pane-header-label">
          {headerLabel}{headerPath ? ` \u00b7 ${headerPath}` : ''}
        </span>
        <button
          className="terminal-pane-header-btn"
          onClick={handleMaximize}
          title="Toggle maximize"
        >
          {'\u2610'}
        </button>
        <button
          className="terminal-pane-header-btn"
          onClick={handleClose}
          title="Close pane"
        >
          {'\u2715'}
        </button>
      </div>
      <div className={`terminal-pane-body ${isPlaceholder ? 'terminal-pane-body--placeholder' : ''}`}>
        {isPlaceholder ? (
          <button
            type="button"
            className="terminal-pane-placeholder"
            onClick={handleFocus}
          >
            <span>Drag a session here</span>
            <span>Click a session in the sidebar</span>
          </button>
        ) : (
          <div className="terminal-pane-content">
            <div
              ref={containerRef}
              className="terminal-pane-xterm"
            />
            <PaneStatusStrip claudeSessionId={session?.claudeSessionId} />
          </div>
        )}
        {enablePaneSplitting && isDragging && draggingPaneId !== paneId && (
          <DropZoneOverlay
            paneId={paneId}
            layoutDispatch={layoutDispatch}
            currentLeafCount={currentLeafCount}
            maxPanes={maxPanes}
            isTargetPlaceholder={isPlaceholder}
            isPaneDrag={draggingPaneId !== null}
          />
        )}
      </div>
    </div>
  );
}

function getStatusClass(state?: SessionState): string {
  if (!state) return 'idle';
  switch (state) {
    case 'running':
    case 'starting':
      return 'running';
    case 'waiting':
      return 'waiting';
    case 'stopped':
    case 'dead':
      return 'dead';
    default:
      return 'idle';
  }
}

function abbreviatePath(p: string): string {
  const home = window.electronAPI.homeDir;
  if (home && p.startsWith(home)) {
    return '~' + p.slice(home.length).replace(/\\/g, '/');
  }
  const parts = p.split(/[\\/]/);
  return parts.length > 2 ? `.../${parts.slice(-2).join('/')}` : p;
}
