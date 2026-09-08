import type { CanvasRect, SavedCanvas } from '../../shared/canvas-types';
import type { LayoutNode, LayoutState } from '../../shared/layout-types';
import type { LayoutAction } from '../hooks/useLayoutState';
import { getLeaves } from './layout-tree';

export const MIN_PANEL_WIDTH = 280;
export const MIN_PANEL_HEIGHT = 180;
const GAP = 16;
const LIMIT = 100_000;

export interface CanvasPanel extends CanvasRect {
  id: string;
  sessionId: string;
  z: number;
}

export interface CanvasState {
  initialized: boolean;
  panels: CanvasPanel[];
  focusedPaneId: string | null;
  maximizedPaneId: string | null;
  viewport: { x: number; y: number; width: number; height: number };
}

export const initialCanvasState: CanvasState = {
  initialized: false,
  panels: [],
  focusedPaneId: null,
  maximizedPaneId: null,
  viewport: { x: 0, y: 0, width: 1200, height: 800 },
};

export type CanvasAction = LayoutAction
  | { type: 'SEED'; sessionIds: string[]; focusedSessionId: string | null }
  | { type: 'RESTORE'; saved: SavedCanvas | undefined; sessionIds: Array<string | null> }
  | { type: 'OPEN'; sessionId: string; position?: { x: number; y: number } }
  | { type: 'FOCUS_VISIBLE'; paneId: string }
  | { type: 'RECT'; paneId: string; rect: CanvasRect }
  | { type: 'PAN'; x: number; y: number }
  | { type: 'SIZE'; width: number; height: number }
  | { type: 'ARRANGE' }
  | { type: 'PRUNE'; sessionIds: string[] };

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min;
}

export function normalizeRect(rect: CanvasRect): CanvasRect {
  return {
    x: clamp(rect.x, -LIMIT, LIMIT), y: clamp(rect.y, -LIMIT, LIMIT),
    width: clamp(rect.width, MIN_PANEL_WIDTH, 4096),
    height: clamp(rect.height, MIN_PANEL_HEIGHT, 4096),
  };
}

function nextZ(panels: CanvasPanel[]): number {
  return panels.reduce((z, p) => Math.max(z, p.z), 0) + 1;
}

function reveal(state: CanvasState, panel: CanvasPanel): CanvasState['viewport'] {
  const v = state.viewport;
  const x = panel.x < v.x || panel.x + panel.width > v.x + v.width
    ? panel.x - Math.max(GAP, (v.width - panel.width) / 2) : v.x;
  const y = panel.y < v.y || panel.y + panel.height > v.y + v.height
    ? panel.y - Math.max(GAP, (v.height - panel.height) / 2) : v.y;
  return { ...v, x, y };
}

function focus(state: CanvasState, paneId: string | null, shouldReveal = true): CanvasState {
  const panel = state.panels.find(p => p.id === paneId);
  if (!panel) return state;
  // Focus events from xterm must be idempotent: they also fire after attachment.
  const maxZ = nextZ(state.panels) - 1;
  const viewport = shouldReveal ? reveal(state, panel) : state.viewport;
  if (state.focusedPaneId === paneId && panel.z === maxZ
    && viewport.x === state.viewport.x && viewport.y === state.viewport.y) return state;
  return {
    ...state, focusedPaneId: paneId,
    maximizedPaneId: state.maximizedPaneId === paneId ? paneId : null,
    viewport,
    panels: state.panels.map(p => p.id === paneId ? { ...p, z: maxZ + 1 } : p),
  };
}

function arrange(state: CanvasState): CanvasState {
  if (!state.panels.length) return state;
  const { width, height } = state.viewport;
  const maxColumns = Math.max(1, Math.floor((width - GAP) / (MIN_PANEL_WIDTH + GAP)));
  const columns = Math.min(maxColumns, Math.max(1, Math.ceil(Math.sqrt(state.panels.length * width / height))));
  const rows = Math.ceil(state.panels.length / columns);
  const panelWidth = Math.max(MIN_PANEL_WIDTH, (width - GAP * (columns + 1)) / columns);
  const panelHeight = Math.max(MIN_PANEL_HEIGHT, (height - GAP * (rows + 1)) / rows);
  return {
    ...state, maximizedPaneId: null, viewport: { ...state.viewport, x: 0, y: 0 },
    panels: state.panels.map((p, i) => ({ ...p,
      x: GAP + (i % columns) * (panelWidth + GAP),
      y: GAP + Math.floor(i / columns) * (panelHeight + GAP),
      width: Math.min(4096, panelWidth), height: Math.min(4096, panelHeight),
    })),
  };
}

function open(state: CanvasState, sessionId: string, position?: { x: number; y: number }): CanvasState {
  const existing = state.panels.find(p => p.sessionId === sessionId);
  if (existing) return focus(state, existing.id);
  const offset = (state.panels.length % 8) * 32;
  // Swapping/restarting sessions preserves panel IDs. The original ID can now
  // belong to another session, so reopening must allocate a distinct panel.
  const baseId = `canvas-${sessionId}`;
  let id = baseId;
  let suffix = 1;
  while (state.panels.some(p => p.id === id)) id = `${baseId}-${suffix++}`;
  const panel: CanvasPanel = {
    id, sessionId, z: nextZ(state.panels),
    ...normalizeRect({
      x: position?.x ?? state.viewport.x + GAP + offset,
      y: position?.y ?? state.viewport.y + GAP + offset,
      width: Math.min(640, state.viewport.width - GAP * 2),
      height: Math.min(420, state.viewport.height - GAP * 2),
    }),
  };
  return focus({ ...state, initialized: true, panels: [...state.panels, panel] }, panel.id);
}

function prune(state: CanvasState, keep: (panel: CanvasPanel) => boolean): CanvasState {
  const panels = state.panels.filter(keep);
  if (panels.length === state.panels.length) return state;
  const focusedPaneId = panels.some(p => p.id === state.focusedPaneId)
    ? state.focusedPaneId : [...panels].sort((a, b) => b.z - a.z)[0]?.id ?? null;
  return { ...state, panels, focusedPaneId,
    maximizedPaneId: panels.some(p => p.id === state.maximizedPaneId) ? state.maximizedPaneId : null };
}

export function canvasReducer(state: CanvasState, action: CanvasAction): CanvasState {
  switch (action.type) {
    case 'SEED': {
      if (state.initialized) return state;
      let next = { ...state, initialized: true };
      for (const id of action.sessionIds) next = open(next, id);
      next = arrange(next);
      return focus(next, next.panels.find(p => p.sessionId === action.focusedSessionId)?.id ?? next.panels[0]?.id ?? null);
    }
    case 'RESTORE': return restoreCanvas(action.saved, action.sessionIds, state.viewport);
    case 'OPEN': return open(state, action.sessionId, action.position);
    case 'ADD_PANE': return open(state, action.sessionId);
    case 'SET_FOCUS': return focus(state, action.paneId);
    case 'FOCUS_VISIBLE': return focus(state, action.paneId, false);
    case 'TOGGLE_MAXIMIZE': {
      if (!state.panels.some(p => p.id === action.paneId)) return state;
      return { ...state, focusedPaneId: action.paneId,
        maximizedPaneId: state.maximizedPaneId === action.paneId ? null : action.paneId };
    }
    case 'RECT': return { ...state, panels: state.panels.map(p => p.id === action.paneId ? { ...p, ...normalizeRect(action.rect) } : p) };
    case 'PAN': return { ...state, viewport: { ...state.viewport,
      x: clamp(action.x, -LIMIT, LIMIT), y: clamp(action.y, -LIMIT, LIMIT) } };
    case 'SIZE': return state.viewport.width === action.width && state.viewport.height === action.height ? state
      : { ...state, viewport: { ...state.viewport, width: Math.max(1, action.width), height: Math.max(1, action.height) } };
    case 'ARRANGE': return arrange(state);
    case 'REMOVE_PANE':
    case 'COMPACT_PLACEHOLDER': return prune(state, p => p.id !== action.paneId);
    case 'REMOVE_SESSION': return prune(state, p => p.sessionId !== action.sessionId);
    case 'PRUNE': return prune(state, p => action.sessionIds.includes(p.sessionId));
    case 'REPLACE_SESSION': {
      const existing = state.panels.find(p => p.sessionId === action.sessionId);
      if (existing) return focus(state, existing.id);
      return { ...state, panels: state.panels.map(p => p.id === action.paneId ? { ...p, sessionId: action.sessionId } : p) };
    }
    case 'SWAP_PANES': {
      const a = state.panels.find(p => p.id === action.sourcePaneId);
      const b = state.panels.find(p => p.id === action.targetPaneId);
      if (!a || !b) return state;
      return { ...state, panels: state.panels.map(p => p.id === a.id ? { ...p, sessionId: b.sessionId }
        : p.id === b.id ? { ...p, sessionId: a.sessionId } : p) };
    }
    case 'SET_ROOT': {
      let next: CanvasState = { ...state, panels: [], focusedPaneId: null, maximizedPaneId: null };
      for (const leaf of getLeaves(action.root)) {
        if (leaf.sessionId) next = open(next, leaf.sessionId);
      }
      return next;
    }
    default: return state;
  }
}

/** Read-only projection for existing session cycling and broadcast helpers.
 * Geometry belongs exclusively to panels; splits never govern canvas positions. */
export function canvasLayoutState(state: CanvasState): LayoutState {
  function tree(panels: CanvasPanel[]): LayoutNode | null {
    if (!panels.length) return null;
    if (panels.length === 1) return { type: 'leaf', id: panels[0].id, sessionId: panels[0].sessionId };
    const middle = Math.ceil(panels.length / 2);
    return { type: 'split', id: `canvas-group-${panels[0].id}`, direction: 'horizontal', ratio: 0.5,
      children: [tree(panels.slice(0, middle))!, tree(panels.slice(middle))!] };
  }
  return { root: tree(state.panels), focusedPaneId: state.focusedPaneId,
    maximizedPaneId: state.maximizedPaneId, maxPanes: Number.POSITIVE_INFINITY };
}

export function visibleCanvasPanels(state: CanvasState): CanvasPanel[] {
  if (state.maximizedPaneId) return state.panels.filter(p => p.id === state.maximizedPaneId);
  const v = state.viewport;
  const candidates = state.panels.filter(p => p.x + p.width > v.x && p.x < v.x + v.width
    && p.y + p.height > v.y && p.y < v.y + v.height);
  const covered: CanvasRect[] = [];
  const visible = new Set<string>();
  for (const panel of [...candidates].sort((a, b) => b.z - a.z)) {
    const x = Math.max(panel.x, v.x);
    const y = Math.max(panel.y, v.y);
    let fragments: CanvasRect[] = [{ x, y,
      width: Math.min(panel.x + panel.width, v.x + v.width) - x,
      height: Math.min(panel.y + panel.height, v.y + v.height) - y }];
    for (const cover of covered) {
      fragments = fragments.flatMap(fragment => subtractRect(fragment, cover));
      if (!fragments.length) break;
    }
    if (fragments.length) visible.add(panel.id);
    covered.push(panel);
  }
  return candidates.filter(p => visible.has(p.id));
}

/** Remaining visible pieces after an opaque panel covers part of a rectangle. */
function subtractRect(rect: CanvasRect, cover: CanvasRect): CanvasRect[] {
  const left = Math.max(rect.x, cover.x);
  const top = Math.max(rect.y, cover.y);
  const right = Math.min(rect.x + rect.width, cover.x + cover.width);
  const bottom = Math.min(rect.y + rect.height, cover.y + cover.height);
  if (left >= right || top >= bottom) return [rect];
  return [
    { x: rect.x, y: rect.y, width: rect.width, height: top - rect.y },
    { x: rect.x, y: bottom, width: rect.width, height: rect.y + rect.height - bottom },
    { x: rect.x, y: top, width: left - rect.x, height: bottom - top },
    { x: right, y: top, width: rect.x + rect.width - right, height: bottom - top },
  ].filter(part => part.width > 0 && part.height > 0);
}

export function adjacentCanvasPanel(state: CanvasState, direction: 'left' | 'right' | 'up' | 'down'): string | null {
  const source = state.panels.find(p => p.id === state.focusedPaneId);
  if (!source) return null;
  const horizontal = direction === 'left' || direction === 'right';
  const sign = direction === 'left' || direction === 'up' ? -1 : 1;
  const cx = source.x + source.width / 2;
  const cy = source.y + source.height / 2;
  return state.panels.filter(p => p.id !== source.id)
    .map(p => {
      const dx = p.x + p.width / 2 - cx;
      const dy = p.y + p.height / 2 - cy;
      return { id: p.id, along: (horizontal ? dx : dy) * sign, distance: Math.hypot(dx, dy) };
    }).filter(p => p.along > 0).sort((a, b) => a.distance - b.distance)[0]?.id ?? null;
}

export function saveCanvas(state: CanvasState, sessionIds: string[]): SavedCanvas | undefined {
  if (!state.initialized) return undefined;
  return {
    panels: state.panels.filter(p => sessionIds.includes(p.sessionId)).map(p => ({
      sessionIndex: sessionIds.indexOf(p.sessionId), x: p.x, y: p.y, width: p.width, height: p.height, z: p.z,
    })),
    viewport: { x: state.viewport.x, y: state.viewport.y },
    focusedSessionIndex: sessionIds.indexOf(state.panels.find(p => p.id === state.focusedPaneId)?.sessionId ?? ''),
  };
}

export function restoreCanvas(saved: SavedCanvas | undefined, sessionIds: Array<string | null>, viewport = initialCanvasState.viewport): CanvasState {
  if (!saved || !Array.isArray(saved.panels)) return { ...initialCanvasState, viewport };
  const seen = new Set<string>();
  const panels = saved.panels.flatMap(p => {
    if (!p || !Number.isInteger(p.sessionIndex)) return [];
    const sessionId = sessionIds[p.sessionIndex];
    if (!sessionId || seen.has(sessionId)) return [];
    seen.add(sessionId);
    return [{ ...normalizeRect(p), id: `canvas-${sessionId}`, sessionId, z: clamp(p.z, 0, LIMIT) }];
  });
  const focusedSessionId = sessionIds[saved.focusedSessionIndex ?? -1];
  return {
    initialized: true, panels, maximizedPaneId: null,
    focusedPaneId: panels.find(p => p.sessionId === focusedSessionId)?.id ?? panels[0]?.id ?? null,
    viewport: { ...viewport, x: clamp(saved.viewport?.x ?? 0, -LIMIT, LIMIT), y: clamp(saved.viewport?.y ?? 0, -LIMIT, LIMIT) },
  };
}
