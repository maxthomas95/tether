import { useRef, useEffect, useCallback } from 'react';
import '@xterm/xterm/css/xterm.css';
import type { SessionInfo, SessionState } from '../../shared/types';
import type { TerminalManagerAPI } from '../hooks/useTerminalManager';
import type { LayoutAction } from '../hooks/useLayoutState';
import { DropZoneOverlay } from './DropZoneOverlay';

interface TerminalPaneProps {
  paneId: string;
  sessionId: string;
  session: SessionInfo | undefined;
  isFocused: boolean;
  isDragging: boolean;
  onDragStateChange: (dragging: boolean) => void;
  layoutDispatch: React.Dispatch<LayoutAction>;
  termManager: TerminalManagerAPI;
}

export function TerminalPane({
  paneId,
  sessionId,
  session,
  isFocused,
  isDragging,
  onDragStateChange,
  layoutDispatch,
  termManager,
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<ResizeObserver | null>(null);

  // Mount terminal into container
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

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

  return (
    <div
      className={`terminal-pane ${isFocused ? 'terminal-pane--focused' : ''}`}
      onFocus={handleFocus}
      onMouseDown={handleFocus}
    >
      <div
        className="terminal-pane-header"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('application/tether-pane', paneId);
          e.dataTransfer.setData('application/tether-session', sessionId);
          e.dataTransfer.effectAllowed = 'move';
          onDragStateChange(true);
        }}
        onDragEnd={() => onDragStateChange(false)}
      >
        <span className={`status-dot status-dot--${getStatusClass(session?.state)}`} />
        <span className="terminal-pane-header-label">
          {label}{path ? ` \u00b7 ${path}` : ''}
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
      <div className="terminal-pane-body" style={{ position: 'relative' }}>
        <div
          ref={containerRef}
          style={{ flex: 1, overflow: 'hidden', width: '100%', height: '100%' }}
        />
        {isDragging && (
          <DropZoneOverlay paneId={paneId} layoutDispatch={layoutDispatch} />
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
