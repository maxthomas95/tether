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

describe('split layout focus and maximize', () => {
  it('drops the maximize when focus moves to a pane it hides', () => {
    const next = layoutReducer(state({ maximizedPaneId: 'left' }), { type: 'SET_FOCUS', paneId: 'right' });
    expect(next.focusedPaneId).toBe('right');
    expect(next.maximizedPaneId).toBeNull();
  });

  it('keeps the maximize when the maximized pane is focused again', () => {
    const before = state({ maximizedPaneId: 'left' });
    const next = layoutReducer(before, { type: 'SET_FOCUS', paneId: 'left' });
    expect(next).toBe(before);
  });

  it('treats a repeated focus on the same pane as a no-op', () => {
    const before = state();
    expect(layoutReducer(before, { type: 'SET_FOCUS', paneId: 'left' })).toBe(before);
  });

  it('keeps the maximize when focus is cleared', () => {
    const next = layoutReducer(state({ maximizedPaneId: 'left' }), { type: 'SET_FOCUS', paneId: null });
    expect(next.focusedPaneId).toBeNull();
    expect(next.maximizedPaneId).toBe('left');
  });

  it('focuses a pane when it is maximized', () => {
    const next = layoutReducer(state(), { type: 'TOGGLE_MAXIMIZE', paneId: 'right' });
    expect(next.maximizedPaneId).toBe('right');
    expect(next.focusedPaneId).toBe('right');
  });

  it('restores the split without moving focus when the maximize is toggled off', () => {
    const next = layoutReducer(state({ maximizedPaneId: 'left' }), { type: 'TOGGLE_MAXIMIZE', paneId: 'left' });
    expect(next.maximizedPaneId).toBeNull();
    expect(next.focusedPaneId).toBe('left');
  });

  it('shows a session placed into a hidden empty pane', () => {
    const withEmpty: LayoutNode = {
      ...twoPanes,
      children: [{ type: 'leaf', id: 'left', sessionId: 'a' }, { type: 'leaf', id: 'right', sessionId: null }],
    } as LayoutNode;
    let next = layoutReducer(state({ root: withEmpty, maximizedPaneId: 'left' }),
      { type: 'REPLACE_SESSION', paneId: 'right', sessionId: 'c' });
    next = layoutReducer(next, { type: 'SET_FOCUS', paneId: 'right' });
    expect(next.maximizedPaneId).toBeNull();
    expect(next.focusedPaneId).toBe('right');
  });

  it('drops the maximize when a new pane takes the focus', () => {
    const single: LayoutNode = { type: 'leaf', id: 'only', sessionId: 'a' };
    const next = layoutReducer(
      state({ root: single, focusedPaneId: 'only', maximizedPaneId: 'only' }),
      { type: 'ADD_PANE', targetPaneId: 'only', sessionId: 'b', zone: 'right' },
    );
    expect(next.focusedPaneId).not.toBe('only');
    expect(next.maximizedPaneId).toBeNull();
  });

  it('never leaves a maximize hiding the focused pane after a session is removed', () => {
    const next = layoutReducer(state({ maximizedPaneId: 'left' }), { type: 'REMOVE_SESSION', sessionId: 'b' });
    const focused = getLeaves(next.root).find(leaf => leaf.id === next.focusedPaneId);
    expect(focused?.sessionId).toBe('a');
    expect([null, next.focusedPaneId]).toContain(next.maximizedPaneId);
  });
});
