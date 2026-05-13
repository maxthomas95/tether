import { describe, it, expect } from 'vitest';
import type { LayoutNode, LayoutSplit } from '../../shared/layout-types';
import {
  addPane,
  addPaneConstrained,
  buildConstrainedLayout,
  compactPlaceholders,
  getLeafCount,
  getLeaves,
  getPaneLocationForSession,
  isConstrainedLayout,
  normalizeToConstrained,
} from './layout-tree';

describe('constrained layout tree helpers', () => {
  it('builds canonical 1, 2, and 4 pane layouts', () => {
    const single = buildConstrainedLayout(['s1']);
    expect(single?.type).toBe('leaf');
    expect(getLeafCount(single)).toBe(1);

    const split = buildConstrainedLayout(['s1', 's2'], 'vertical');
    expect(split?.type).toBe('split');
    expect((split as LayoutSplit).direction).toBe('vertical');
    expect((split as LayoutSplit).ratio).toBe(0.5);
    expect(getLeafCount(split)).toBe(2);

    const grid = buildConstrainedLayout(['tl', 'tr', 'bl', null]);
    expect(isConstrainedLayout(grid, 4)).toBe(true);
    expect(getLeafCount(grid)).toBe(4);
    expect(getGridSessions(grid!)).toEqual(['tl', 'tr', 'bl', null]);
  });

  it('jumps from two panes to a four-pane grid with an empty placeholder', () => {
    const twoPane = buildConstrainedLayout(['s1', 's2'])!;
    const { root, newPaneId } = addPaneConstrained(twoPane, 's3', 4, getLeaves(twoPane)[0].id);

    expect(isConstrainedLayout(root, 4)).toBe(true);
    expect(getLeafCount(root)).toBe(4);
    expect(getLeaves(root).find(l => l.id === newPaneId)?.sessionId).toBe('s3');
    expect(getGridSessions(root)).toEqual(['s1', 's2', 's3', null]);
  });

  it('uses the requested empty quadrant when jumping from two panes to four', () => {
    const twoPane = buildConstrainedLayout(['s1', 's2'])!;
    const { root } = addPaneConstrained(twoPane, 's3', 4, getLeaves(twoPane)[0].id, 'bottom-right');

    expect(getGridSessions(root)).toEqual(['s1', 's2', null, 's3']);
  });

  it('fills an existing placeholder instead of adding past the max pane count', () => {
    const grid = buildConstrainedLayout(['s1', 's2', 's3', null])!;
    const placeholder = getLeaves(grid).find(l => l.sessionId === null)!;
    const { root, newPaneId } = addPaneConstrained(grid, 's4', 4, placeholder.id);

    expect(newPaneId).toBe(placeholder.id);
    expect(isConstrainedLayout(root, 4)).toBe(true);
    expect(getGridSessions(root)).toEqual(['s1', 's2', 's3', 's4']);
  });

  it('normalizes invalid three-pane trees by prioritizing the focused pane when trimming', () => {
    let root: LayoutNode = buildConstrainedLayout(['s1', 's2'])!;
    root = addPane(root, getLeaves(root)[1].id, 's3', 'right');
    const focusedPaneId = getLeaves(root).find(l => l.sessionId === 's3')!.id;

    const normalized = normalizeToConstrained(root, 2, focusedPaneId);

    expect(isConstrainedLayout(normalized, 2)).toBe(true);
    expect(getLeafCount(normalized)).toBe(2);
    expect(getLeaves(normalized).map(l => l.sessionId)).toContain('s3');
  });
});

describe('compactPlaceholders', () => {
  it('collapses a 4-grid with one session and three placeholders down to a single fullscreen pane in one shot', () => {
    const root: LayoutNode = buildConstrainedLayout(['s1', null, null, null])!;
    expect(getLeafCount(root)).toBe(4);
    const placeholder = getLeaves(root).find(l => l.sessionId === null)!;

    const compacted = compactPlaceholders(root, placeholder.id)!;

    // One click on any placeholder X drops every empty slot, not just the targeted one.
    expect(compacted.type).toBe('leaf');
    expect(getLeafCount(compacted)).toBe(1);
    expect((compacted as { sessionId: string | null }).sessionId).toBe('s1');
  });

  it('collapses a 4-grid with two sessions to a 2-pane split when a placeholder is removed', () => {
    const root: LayoutNode = buildConstrainedLayout(['s1', 's2', null, null])!;
    const placeholder = getLeaves(root).find(l => l.sessionId === null)!;

    const compacted = compactPlaceholders(root, placeholder.id)!;

    expect(isConstrainedLayout(compacted, 2)).toBe(true);
    expect(getLeafCount(compacted)).toBe(2);
    expect(getLeaves(compacted).map(l => l.sessionId).sort((a, b) => (a ?? '').localeCompare(b ?? ''))).toEqual(['s1', 's2']);
  });

  it('keeps the 2x2 shape when removing one of two placeholders from a 3-session grid', () => {
    const root: LayoutNode = buildConstrainedLayout(['s1', 's2', 's3', null])!;
    const placeholder = getLeaves(root).find(l => l.sessionId === null)!;

    const compacted = compactPlaceholders(root, placeholder.id)!;

    // Three real sessions can't tile cleanly without a placeholder, so 2x2 stays.
    expect(getLeafCount(compacted)).toBe(4);
    expect(getLeaves(compacted).filter(l => l.sessionId !== null).map(l => l.sessionId).sort((a, b) => (a ?? '').localeCompare(b ?? '')))
      .toEqual(['s1', 's2', 's3']);
  });

  it('returns the tree unchanged when the target is a session-bearing leaf', () => {
    const root: LayoutNode = buildConstrainedLayout(['s1', 's2', null, null])!;
    const sessionLeaf = getLeaves(root).find(l => l.sessionId === 's1')!;

    const result = compactPlaceholders(root, sessionLeaf.id);

    expect(result).toBe(root);
  });
});

describe('getPaneLocationForSession', () => {
  it('returns null when the layout is empty or the session is not present', () => {
    expect(getPaneLocationForSession(null, 's1')).toBeNull();
    const single = buildConstrainedLayout(['s1'])!;
    expect(getPaneLocationForSession(single, 'missing')).toBeNull();
  });

  it('classifies a single-leaf layout as shape "single" at slot 0', () => {
    const root = buildConstrainedLayout(['s1'])!;
    const loc = getPaneLocationForSession(root, 's1');
    expect(loc).toMatchObject({ shape: 'single', slotIndex: 0, totalSlots: 1 });
  });

  it('classifies a two-pane horizontal layout as split-h with left=0 / right=1', () => {
    const root = buildConstrainedLayout(['l', 'r'], 'horizontal')!;
    expect(getPaneLocationForSession(root, 'l')).toMatchObject({ shape: 'split-h', slotIndex: 0, totalSlots: 2 });
    expect(getPaneLocationForSession(root, 'r')).toMatchObject({ shape: 'split-h', slotIndex: 1, totalSlots: 2 });
  });

  it('classifies a two-pane vertical layout as split-v with top=0 / bottom=1', () => {
    const root = buildConstrainedLayout(['t', 'b'], 'vertical')!;
    expect(getPaneLocationForSession(root, 't')).toMatchObject({ shape: 'split-v', slotIndex: 0, totalSlots: 2 });
    expect(getPaneLocationForSession(root, 'b')).toMatchObject({ shape: 'split-v', slotIndex: 1, totalSlots: 2 });
  });

  it('reports row-major quadrants for a 2x2 grid: tl=0, tr=1, bl=2, br=3', () => {
    const root = buildConstrainedLayout(['tl', 'tr', 'bl', 'br'])!;
    expect(getPaneLocationForSession(root, 'tl')).toMatchObject({ shape: 'grid', slotIndex: 0, totalSlots: 4 });
    expect(getPaneLocationForSession(root, 'tr')).toMatchObject({ shape: 'grid', slotIndex: 1, totalSlots: 4 });
    expect(getPaneLocationForSession(root, 'bl')).toMatchObject({ shape: 'grid', slotIndex: 2, totalSlots: 4 });
    expect(getPaneLocationForSession(root, 'br')).toMatchObject({ shape: 'grid', slotIndex: 3, totalSlots: 4 });
  });
});

function getGridSessions(root: LayoutNode): Array<string | null> {
  expect(root.type).toBe('split');
  const [left, right] = (root as LayoutSplit).children;
  expect(left.type).toBe('split');
  expect(right.type).toBe('split');

  const leftSplit = left as LayoutSplit;
  const rightSplit = right as LayoutSplit;
  expect(leftSplit.children[0].type).toBe('leaf');
  expect(leftSplit.children[1].type).toBe('leaf');
  expect(rightSplit.children[0].type).toBe('leaf');
  expect(rightSplit.children[1].type).toBe('leaf');

  return [
    leftSplit.children[0].sessionId,
    rightSplit.children[0].sessionId,
    leftSplit.children[1].sessionId,
    rightSplit.children[1].sessionId,
  ];
}
