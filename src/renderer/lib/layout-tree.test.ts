import { describe, it, expect } from 'vitest';
import type { LayoutNode, LayoutSplit } from '../../shared/layout-types';
import {
  addPane,
  addPaneConstrained,
  buildConstrainedLayout,
  compactPlaceholders,
  getAdjacentPane,
  getLeafCount,
  getLeaves,
  getPaneLocationForSession,
  isConstrainedLayout,
  normalizeToConstrained,
  swapLeafSessions,
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

describe('getAdjacentPane', () => {
  function paneIdOf(root: LayoutNode, sessionId: string): string {
    const leaf = getLeaves(root).find(l => l.sessionId === sessionId);
    if (!leaf) throw new Error(`session ${sessionId} not found`);
    return leaf.id;
  }
  function sessionAtPane(root: LayoutNode, paneId: string | null): string | null | undefined {
    if (!paneId) return undefined;
    return getLeaves(root).find(l => l.id === paneId)?.sessionId;
  }

  it('returns null in every direction for a single-leaf layout', () => {
    const root = buildConstrainedLayout(['solo'])!;
    const id = paneIdOf(root, 'solo');
    expect(getAdjacentPane(root, id, 'left')).toBeNull();
    expect(getAdjacentPane(root, id, 'right')).toBeNull();
    expect(getAdjacentPane(root, id, 'up')).toBeNull();
    expect(getAdjacentPane(root, id, 'down')).toBeNull();
  });

  it('resolves left/right in a horizontal split and returns null on the orthogonal axis', () => {
    const root = buildConstrainedLayout(['l', 'r'], 'horizontal')!;
    const lId = paneIdOf(root, 'l');
    const rId = paneIdOf(root, 'r');
    expect(sessionAtPane(root, getAdjacentPane(root, lId, 'right'))).toBe('r');
    expect(sessionAtPane(root, getAdjacentPane(root, rId, 'left'))).toBe('l');
    expect(getAdjacentPane(root, lId, 'up')).toBeNull();
    expect(getAdjacentPane(root, lId, 'down')).toBeNull();
    expect(getAdjacentPane(root, lId, 'left')).toBeNull();
    expect(getAdjacentPane(root, rId, 'right')).toBeNull();
  });

  it('resolves up/down in a vertical split and returns null on the orthogonal axis', () => {
    const root = buildConstrainedLayout(['t', 'b'], 'vertical')!;
    const tId = paneIdOf(root, 't');
    const bId = paneIdOf(root, 'b');
    expect(sessionAtPane(root, getAdjacentPane(root, tId, 'down'))).toBe('b');
    expect(sessionAtPane(root, getAdjacentPane(root, bId, 'up'))).toBe('t');
    expect(getAdjacentPane(root, tId, 'left')).toBeNull();
    expect(getAdjacentPane(root, tId, 'right')).toBeNull();
    expect(getAdjacentPane(root, tId, 'up')).toBeNull();
    expect(getAdjacentPane(root, bId, 'down')).toBeNull();
  });

  it('navigates all four cardinals correctly from each corner of a 2x2 grid', () => {
    const root = buildConstrainedLayout(['tl', 'tr', 'bl', 'br'])!;
    const tl = paneIdOf(root, 'tl');
    const tr = paneIdOf(root, 'tr');
    const bl = paneIdOf(root, 'bl');
    const br = paneIdOf(root, 'br');

    expect(sessionAtPane(root, getAdjacentPane(root, tl, 'right'))).toBe('tr');
    expect(sessionAtPane(root, getAdjacentPane(root, tl, 'down'))).toBe('bl');
    expect(getAdjacentPane(root, tl, 'left')).toBeNull();
    expect(getAdjacentPane(root, tl, 'up')).toBeNull();

    expect(sessionAtPane(root, getAdjacentPane(root, tr, 'left'))).toBe('tl');
    expect(sessionAtPane(root, getAdjacentPane(root, tr, 'down'))).toBe('br');
    expect(getAdjacentPane(root, tr, 'right')).toBeNull();
    expect(getAdjacentPane(root, tr, 'up')).toBeNull();

    expect(sessionAtPane(root, getAdjacentPane(root, bl, 'right'))).toBe('br');
    expect(sessionAtPane(root, getAdjacentPane(root, bl, 'up'))).toBe('tl');
    expect(getAdjacentPane(root, bl, 'left')).toBeNull();
    expect(getAdjacentPane(root, bl, 'down')).toBeNull();

    expect(sessionAtPane(root, getAdjacentPane(root, br, 'left'))).toBe('bl');
    expect(sessionAtPane(root, getAdjacentPane(root, br, 'up'))).toBe('tr');
    expect(getAdjacentPane(root, br, 'right')).toBeNull();
    expect(getAdjacentPane(root, br, 'down')).toBeNull();
  });

  it('returns null when the source pane id is not in the tree', () => {
    const root = buildConstrainedLayout(['s1', 's2'])!;
    expect(getAdjacentPane(root, 'no-such-id', 'right')).toBeNull();
  });
});

describe('swapLeafSessions', () => {
  it('exchanges session ids between two leaves in a 2-pane layout', () => {
    const root = buildConstrainedLayout(['a', 'b'])!;
    const [first, second] = getLeaves(root);
    const swapped = swapLeafSessions(root, first.id, second.id);
    const newLeaves = getLeaves(swapped);
    expect(newLeaves.find(l => l.id === first.id)?.sessionId).toBe('b');
    expect(newLeaves.find(l => l.id === second.id)?.sessionId).toBe('a');
  });

  it('preserves pane ids and tree shape — only sessionId fields change', () => {
    const root = buildConstrainedLayout(['tl', 'tr', 'bl', 'br'])!;
    const tl = getLeaves(root).find(l => l.sessionId === 'tl')!;
    const br = getLeaves(root).find(l => l.sessionId === 'br')!;
    const swapped = swapLeafSessions(root, tl.id, br.id);

    expect(getLeafCount(swapped)).toBe(4);
    expect(isConstrainedLayout(swapped, 4)).toBe(true);
    const swappedIds = getLeaves(swapped).map(l => l.id).sort();
    const originalIds = getLeaves(root).map(l => l.id).sort();
    expect(swappedIds).toEqual(originalIds);
    expect(getLeaves(swapped).find(l => l.id === tl.id)?.sessionId).toBe('br');
    expect(getLeaves(swapped).find(l => l.id === br.id)?.sessionId).toBe('tl');
  });

  it('is idempotent over a double swap', () => {
    const root = buildConstrainedLayout(['a', 'b'])!;
    const [first, second] = getLeaves(root);
    const once = swapLeafSessions(root, first.id, second.id);
    const twice = swapLeafSessions(once, first.id, second.id);
    expect(getLeaves(twice).map(l => ({ id: l.id, sessionId: l.sessionId })))
      .toEqual(getLeaves(root).map(l => ({ id: l.id, sessionId: l.sessionId })));
  });

  it('returns the tree unchanged when either pane id is missing', () => {
    const root = buildConstrainedLayout(['a', 'b'])!;
    const [first] = getLeaves(root);
    expect(swapLeafSessions(root, first.id, 'no-such-id')).toBe(root);
    expect(swapLeafSessions(root, 'no-such-id', first.id)).toBe(root);
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
