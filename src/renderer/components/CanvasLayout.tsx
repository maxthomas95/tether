import { useCallback, useEffect, useRef, useState } from 'react';
import type { CanvasRect } from '../../shared/canvas-types';
import type { EnvironmentInfo, SessionInfo } from '../../shared/types';
import type { TerminalManagerAPI } from '../hooks/useTerminalManager';
import type { LayoutAction } from '../hooks/useLayoutState';
import {
  type CanvasAction, type CanvasState, MIN_PANEL_HEIGHT, MIN_PANEL_WIDTH,
  normalizeRect, visibleCanvasPanels,
} from '../lib/canvas-layout';
import { TerminalPane } from './TerminalPane';
import '../styles/canvas.css';

interface CanvasLayoutProps {
  state: CanvasState;
  dispatch: React.Dispatch<CanvasAction>;
  termManager: TerminalManagerAPI;
  sessions: SessionInfo[];
  environments: EnvironmentInfo[];
  defaultFontSize: number;
  onFontSizeDelta: (sessionId: string, delta: number) => void;
  onRestartInPane: (paneId: string, sessionId: string) => void;
  onChooseSession: () => void;
  onDropComplete: () => void;
}

interface Gesture {
  pointerId: number;
  kind: 'pan' | 'move' | 'resize';
  paneId?: string;
  edge: string;
  startX: number;
  startY: number;
  dx: number;
  dy: number;
  rect: CanvasRect;
}

export function resizeCanvasRect(rect: CanvasRect, edge: string, dx: number, dy: number): CanvasRect {
  const result = { ...rect };
  if (edge.includes('e')) result.width = Math.max(MIN_PANEL_WIDTH, rect.width + dx);
  if (edge.includes('s')) result.height = Math.max(MIN_PANEL_HEIGHT, rect.height + dy);
  if (edge.includes('w')) {
    result.width = Math.max(MIN_PANEL_WIDTH, rect.width - dx);
    result.x = rect.x + rect.width - result.width;
  }
  if (edge.includes('n')) {
    result.height = Math.max(MIN_PANEL_HEIGHT, rect.height - dy);
    result.y = rect.y + rect.height - result.height;
  }
  return normalizeRect(result);
}

function gestureRect(gesture: Gesture): CanvasRect {
  if (gesture.kind === 'resize') return resizeCanvasRect(gesture.rect, gesture.edge, gesture.dx, gesture.dy);
  return normalizeRect({ ...gesture.rect, x: gesture.rect.x + gesture.dx, y: gesture.rect.y + gesture.dy });
}

const EDGES = ['n', 'e', 's', 'w', 'ne', 'se', 'sw', 'nw'];
const EDGE_NAMES: Record<string, string> = { n: 'top', e: 'right', s: 'bottom', w: 'left', ne: 'top right', se: 'bottom right', sw: 'bottom left', nw: 'top left' };
const noop = () => {};

export function CanvasLayout({ state, dispatch, termManager, sessions, environments, defaultFontSize,
  onFontSizeDelta, onRestartInPane, onChooseSession, onDropComplete }: CanvasLayoutProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      dispatch({ type: 'SIZE', width: element.clientWidth, height: element.clientHeight });
    });
    observer.observe(element);
    dispatch({ type: 'SIZE', width: element.clientWidth, height: element.clientHeight });
    return () => observer.disconnect();
  }, [dispatch]);

  const paneDispatch = useCallback((action: LayoutAction) => {
    if (action.type === 'SET_FOCUS' && action.paneId) {
      dispatch({ type: 'FOCUS_VISIBLE', paneId: action.paneId });
    } else {
      dispatch(action);
    }
  }, [dispatch]);

  const preview: CanvasState = gesture?.kind === 'pan'
    ? { ...state, viewport: { ...state.viewport, x: gesture.rect.x - gesture.dx, y: gesture.rect.y - gesture.dy } }
    : gesture?.paneId ? { ...state, panels: state.panels.map(p => p.id === gesture.paneId ? { ...p, ...gestureRect(gesture) } : p) }
      : state;
  const visible = visibleCanvasPanels(preview);

  const begin = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.button !== 1) return;
    const target = e.target as HTMLElement;
    const panelElement = target.closest<HTMLElement>('[data-canvas-panel]');
    const edge = target.closest<HTMLElement>('[data-resize-edge]')?.dataset.resizeEdge;
    const header = target.closest('.terminal-pane-header');
    if (panelElement && (!edge && (!header || target.closest('button')))) return;
    if (state.maximizedPaneId || (!panelElement && target !== e.currentTarget)) return;
    const panel = state.panels.find(p => p.id === panelElement?.dataset.canvasPanel);
    const next: Gesture = {
      pointerId: e.pointerId, kind: panel ? edge ? 'resize' : 'move' : 'pan',
      paneId: panel?.id, edge: edge ?? '', startX: e.clientX, startY: e.clientY, dx: 0, dy: 0,
      rect: panel ?? { ...state.viewport },
    };
    e.preventDefault();
    if (panel) {
      dispatch({ type: 'FOCUS_VISIBLE', paneId: panel.id });
      termManager.focusPane(panel.id);
    } else {
      e.currentTarget.focus();
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    gestureRef.current = next;
    setGesture(next);
  };

  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const current = gestureRef.current;
    if (!current || current.pointerId !== e.pointerId) return;
    const next = { ...current, dx: e.clientX - current.startX, dy: e.clientY - current.startY };
    gestureRef.current = next;
    setGesture(next);
  };

  const finish = (e: React.PointerEvent<HTMLDivElement>, commit: boolean) => {
    const current = gestureRef.current;
    if (!current || current.pointerId !== e.pointerId) return;
    if (commit) {
      const last = { ...current, dx: e.clientX - current.startX, dy: e.clientY - current.startY };
      if (last.kind === 'pan') dispatch({ type: 'PAN', x: last.rect.x - last.dx, y: last.rect.y - last.dy });
      else if (last.paneId) dispatch({ type: 'RECT', paneId: last.paneId, rect: gestureRect(last) });
    }
    gestureRef.current = null;
    setGesture(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return (
    <div className="canvas-workspace">
      <div className="canvas-tools">
        <span className="canvas-help">Drag headers to move · Drag empty space to pan</span>
        <span className="canvas-panel-count">{state.panels.length} {state.panels.length === 1 ? 'panel' : 'panels'}</span>
        <button type="button" onClick={onChooseSession}>Add session</button>
        <button type="button" disabled={!state.focusedPaneId} onClick={() => dispatch({ type: 'SET_FOCUS', paneId: state.focusedPaneId })}>Go to focused</button>
        <button type="button" disabled={!state.panels.length} onClick={() => dispatch({ type: 'ARRANGE' })} title="Resize and arrange panels to use the available space">Arrange panels</button>
      </div>
      <div
        ref={viewportRef}
        className={`canvas-viewport ${gesture ? `canvas-viewport--${gesture.kind}` : ''}`}
        tabIndex={0}
        role="region"
        aria-label="Session canvas. Drag empty space or focus the canvas and use arrow keys to pan."
        style={{ backgroundPosition: `${-preview.viewport.x}px ${-preview.viewport.y}px` }}
        onPointerDown={begin} onPointerMove={move}
        onPointerUp={e => finish(e, true)} onPointerCancel={e => finish(e, false)}
        onLostPointerCapture={() => { gestureRef.current = null; setGesture(null); }}
        onKeyDown={e => {
          if (e.target !== e.currentTarget || state.maximizedPaneId) return;
          const delta = { ArrowLeft: [-80, 0], ArrowRight: [80, 0], ArrowUp: [0, -80], ArrowDown: [0, 80] }[e.key];
          if (!delta) return;
          e.preventDefault();
          dispatch({ type: 'PAN', x: state.viewport.x + delta[0], y: state.viewport.y + delta[1] });
        }}
        onDragOver={e => {
          if (!e.dataTransfer.types.includes('application/tether-session')) return;
          e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy';
        }}
        onDrop={e => {
          e.preventDefault(); e.stopPropagation();
          const sessionId = e.dataTransfer.getData('application/tether-session');
          if (sessions.some(s => s.id === sessionId)) {
            const bounds = e.currentTarget.getBoundingClientRect();
            dispatch({ type: 'OPEN', sessionId, position: {
              x: e.clientX - bounds.left + state.viewport.x,
              y: e.clientY - bounds.top + state.viewport.y,
            } });
          }
          onDropComplete();
        }}
      >
        {!state.panels.length && <div className="canvas-empty">
          <strong>Make room for your sessions</strong>
          <p>Choose sessions from the sidebar or drag them here, then resize and arrange them.</p>
          <button type="button" onClick={onChooseSession}>Choose a session</button>
        </div>}
        {state.panels.length > 0 && visible.length === 0 && <div className="canvas-empty">
          <p>Your panels are elsewhere on the canvas.</p>
          <button type="button" onClick={() => dispatch({ type: 'SET_FOCUS', paneId: state.focusedPaneId ?? state.panels[0].id })}>Go to a panel</button>
        </div>}
        {visible.map(panel => {
          const session = sessions.find(s => s.id === panel.sessionId);
          const maximized = state.maximizedPaneId === panel.id;
          return <div key={panel.id} data-canvas-panel={panel.id}
            className={`canvas-panel ${state.focusedPaneId === panel.id ? 'canvas-panel--focused' : ''}`}
            style={maximized ? { inset: 0, zIndex: panel.z } : {
              left: panel.x - preview.viewport.x, top: panel.y - preview.viewport.y,
              width: panel.width, height: panel.height, zIndex: panel.z,
            }}
            onDoubleClick={e => {
              const target = e.target as HTMLElement;
              if (target.closest('.terminal-pane-header') && !target.closest('button')) dispatch({ type: 'TOGGLE_MAXIMIZE', paneId: panel.id });
            }}
          >
            <TerminalPane
              paneId={panel.id} sessionId={panel.sessionId} session={session}
              environment={environments.find(env => env.id === session?.environmentId)}
              canvas isFocused={state.focusedPaneId === panel.id} isMaximized={maximized}
              onChooseSession={onChooseSession} isDragging={false} draggingPaneId={null}
              onDragStateChange={noop} layoutDispatch={paneDispatch} termManager={termManager}
              enablePaneSplitting={false} currentLeafCount={state.panels.length} maxPanes={Number.POSITIVE_INFINITY}
              defaultFontSize={defaultFontSize} onFontSizeDelta={onFontSizeDelta}
              isBroadcastTarget={false} isBroadcastActive={false} onToggleBroadcastTarget={noop}
              onRestartInPane={onRestartInPane}
            />
            {!maximized && EDGES.map(edge => <button type="button" key={edge}
              className={`canvas-resize canvas-resize--${edge}`} data-resize-edge={edge}
              aria-label={`Resize ${session?.label ?? 'session'} from ${EDGE_NAMES[edge]}`}
              onKeyDown={e => {
                const delta = { ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16] }[e.key];
                if (!delta) return;
                e.preventDefault(); e.stopPropagation();
                dispatch({ type: 'RECT', paneId: panel.id, rect: resizeCanvasRect(panel, edge, delta[0], delta[1]) });
              }}
            />)}
          </div>;
        })}
      </div>
    </div>
  );
}
