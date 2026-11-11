import { describe, expect, it } from 'vitest';
import type { LayoutNode, LayoutState } from '../../shared/layout-types';
import { getLeaves } from '../lib/layout-tree';
import { initialLayoutState, layoutReducer } from './useLayoutState';

const twoPanes: LayoutNode = {
  type: 'split', id: 'split', direction: 'horizontal', ratio: 0.5,
  children: [
    { type: 'leaf', id: 'left', sessionId: 'a' },
    { type: 'leaf', id: 'right', sessionId: 'b' },
  ],
};

function state(overrides: Partial<LayoutState> = {}): LayoutState {
  return { ...initialLayoutState, root: twoPanes, focusedPaneId: 'left', ...overrides };
}

const sessions = (layout: LayoutState) => getLeaves(layout.root).map(leaf => leaf.sessionId);

describe('opening a session', () => {
  it('creates the first pane and focuses it', () => {
    const next = layoutReducer(initialLayoutState, { type: 'OPEN_SESSION', sessionId: 'a', split: false });
    expect(sessions(next)).toEqual(['a']);
    expect(next.focusedPaneId).toBe(getLeaves(next.root)[0].id);
  });

  it('focuses the pane that already shows the session and leaves a maximize', () => {
    const before = state({ maximizedPaneId: 'left' });
    const next = layoutReducer(before, { type: 'OPEN_SESSION', sessionId: 'b', split: true });
    expect(next.root).toBe(before.root);
    expect(next.focusedPaneId).toBe('right');
    expect(next.maximizedPaneId).toBeNull();
  });

  it('replaces the focused pane when not splitting', () => {
    const next = layoutReducer(state(), { type: 'OPEN_SESSION', sessionId: 'c', split: false });
    expect(sessions(next)).toEqual(['c', 'b']);
    expect(next.focusedPaneId).toBe('left');
  });

  it('adds a pane beside the focused one when splitting with room to spare', () => {
    const next = layoutReducer(state(), { type: 'OPEN_SESSION', sessionId: 'c', split: true });
    // Three sessions occupy a four-pane grid; the spare cell is a placeholder.
    expect(sessions(next).filter(Boolean).sort()).toEqual(['a', 'b', 'c']);
    expect(getLeaves(next.root).find(leaf => leaf.sessionId === 'c')?.id).toBe(next.focusedPaneId);
  });

  it('replaces the focused pane when splitting at the pane limit', () => {
    const next = layoutReducer(state({ maxPanes: 2 }), { type: 'OPEN_SESSION', sessionId: 'c', split: true });
    expect(sessions(next)).toEqual(['c', 'b']);
  });

  it('fills an empty pane before splitting again', () => {
    const withPlaceholder: LayoutNode = { ...twoPanes, children: [twoPanes.children[0], { type: 'leaf', id: 'right', sessionId: null }] };
    const next = layoutReducer(state({ root: withPlaceholder }), { type: 'OPEN_SESSION', sessionId: 'c', split: true });
    expect(sessions(next)).toEqual(['a', 'c']);
    expect(next.focusedPaneId).toBe('right');
  });
});

describe('adding and removing panes', () => {
  it('ignores a pane for a session that is already shown', () => {
    const before = state();
    expect(layoutReducer(before, { type: 'ADD_PANE', targetPaneId: 'left', sessionId: 'b', zone: 'right' })).toBe(before);
  });

  it('ignores a pane that would exceed the limit', () => {
    const before = state({ maxPanes: 2 });
    expect(layoutReducer(before, { type: 'ADD_PANE', targetPaneId: 'left', sessionId: 'c', zone: 'right' })).toBe(before);
  });

  it('moves focus and drops the maximize when the maximized pane is removed', () => {
    const next = layoutReducer(state({ maximizedPaneId: 'left' }), { type: 'REMOVE_PANE', paneId: 'left' });
    expect(sessions(next)).toEqual(['b']);
    expect(next.focusedPaneId).toBe(getLeaves(next.root)[0].id);
    expect(next.maximizedPaneId).toBeNull();
  });

  it('keeps focus where it was when another pane is removed', () => {
    const next = layoutReducer(state(), { type: 'REMOVE_PANE', paneId: 'right' });
    expect(sessions(next)).toEqual(['a']);
    expect(next.focusedPaneId).toBe(getLeaves(next.root)[0].id);
  });

  it('empties the layout when the last pane goes', () => {
    const single = state({ root: { type: 'leaf', id: 'only', sessionId: 'a' }, focusedPaneId: 'only' });
    const next = layoutReducer(single, { type: 'REMOVE_PANE', paneId: 'only' });
    expect(next.root).toBeNull();
    expect(next.focusedPaneId).toBeNull();
  });

  it('leaves the layout alone when there is no placeholder to compact', () => {
    const before = state();
    expect(layoutReducer(before, { type: 'COMPACT_PLACEHOLDER', paneId: 'missing' })).toBe(before);
  });

  it('does nothing to an empty layout for replace, move and swap', () => {
    for (const action of [
      { type: 'REPLACE_SESSION', paneId: 'left', sessionId: 'c' },
      { type: 'MOVE_PANE', sourcePaneId: 'left', targetPaneId: 'right', zone: 'right' },
      { type: 'SWAP_PANES', sourcePaneId: 'left', targetPaneId: 'right' },
      { type: 'UPDATE_RATIO', splitId: 'split', ratio: 0.3 },
    ] as const) {
      expect(layoutReducer(initialLayoutState, action), action.type).toBe(initialLayoutState);
    }
  });
});

describe('moving and swapping panes', () => {
  it('swaps sessions and follows the moved one at the pane limit', () => {
    const next = layoutReducer(state({ maxPanes: 2 }), { type: 'MOVE_PANE', sourcePaneId: 'left', targetPaneId: 'right', zone: 'right' });
    expect(sessions(next)).toEqual(['b', 'a']);
    expect(next.focusedPaneId).toBe('right');
  });

  it('re-docks the moved session next to its target below the limit', () => {
    const next = layoutReducer(state(), { type: 'MOVE_PANE', sourcePaneId: 'left', targetPaneId: 'right', zone: 'right' });
    expect(sessions(next)).toEqual(['b', 'a']);
    expect(getLeaves(next.root).find(leaf => leaf.sessionId === 'a')?.id).toBe(next.focusedPaneId);
  });

  it.each([
    ['onto itself', 'left', 'left'],
    ['from a pane that does not exist', 'missing', 'right'],
    ['onto a pane that does not exist', 'left', 'missing'],
  ])('ignores a move %s', (_name, sourcePaneId, targetPaneId) => {
    const before = state();
    expect(layoutReducer(before, { type: 'MOVE_PANE', sourcePaneId, targetPaneId, zone: 'left' })).toBe(before);
    expect(layoutReducer(before, { type: 'SWAP_PANES', sourcePaneId, targetPaneId })).toBe(before);
  });

  it('does not move an empty pane', () => {
    const withPlaceholder: LayoutNode = { ...twoPanes, children: [{ type: 'leaf', id: 'left', sessionId: null }, twoPanes.children[1]] };
    const before = state({ root: withPlaceholder });
    expect(layoutReducer(before, { type: 'MOVE_PANE', sourcePaneId: 'left', targetPaneId: 'right', zone: 'left' })).toBe(before);
  });

  it('swaps two panes in place without changing focus', () => {
    const next = layoutReducer(state(), { type: 'SWAP_PANES', sourcePaneId: 'left', targetPaneId: 'right' });
    expect(sessions(next)).toEqual(['b', 'a']);
    expect(next.focusedPaneId).toBe('left');
  });
});

describe('changing the pane limit', () => {
  it('records the limit on an empty layout and ignores a repeat', () => {
    const next = layoutReducer(initialLayoutState, { type: 'SET_MAX_PANES', maxPanes: 2 });
    expect(next.maxPanes).toBe(2);
    expect(layoutReducer(next, { type: 'SET_MAX_PANES', maxPanes: 2 })).toBe(next);
  });

  it('keeps a layout that already fits', () => {
    const before = state();
    expect(layoutReducer(before, { type: 'SET_MAX_PANES', maxPanes: before.maxPanes })).toBe(before);
  });

  it('collapses to the focused pane when the limit drops to one', () => {
    const next = layoutReducer(state({ focusedPaneId: 'right', maximizedPaneId: 'left' }), { type: 'SET_MAX_PANES', maxPanes: 1 });
    expect(next.maxPanes).toBe(1);
    expect(sessions(next)).toEqual(['b']);
    expect(next.focusedPaneId).toBe(getLeaves(next.root)[0].id);
    expect(next.maximizedPaneId).toBeNull();
  });

  it('replaces the whole tree on SET_ROOT', () => {
    const root: LayoutNode = { type: 'leaf', id: 'solo', sessionId: 'z' };
    expect(layoutReducer(state(), { type: 'SET_ROOT', root }).root).toBe(root);
  });
});
