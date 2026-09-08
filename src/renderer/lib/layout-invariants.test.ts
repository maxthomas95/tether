import { expect, it } from 'vitest';
import type { LayoutNode, DropZone } from '../../shared/layout-types';
import { addPaneConstrained, getLeaves, isConstrainedLayout, normalizeToConstrained, removeSessionFromTree, swapLeafSessions } from './layout-tree';

it.each([1, 2, 4])('preserves sessions across 500 layout operations with max %i panes', max => {
  let root: LayoutNode | null = null;
  let seed = 1729;
  const random = (bound: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return Math.floor((seed / 0x1_0000_0000) * bound);
  };
  const model = new Set<string>();
  const operations = { added: 0, removed: 0, swapped: 0, blocked: 0 };
  const zones: DropZone[] = ['left', 'right', 'top', 'bottom'];
  for (let step = 0; step < 500; step++) {
    const leaves = getLeaves(root);
    const action = random(3);
    if (action === 0 || !leaves.length) {
      const id = `session-${step}`;
      root = addPaneConstrained(root, id, max, leaves[0]?.id, zones[random(zones.length)]).root;
      if (model.size < max) {
        model.add(id);
        operations.added++;
      } else operations.blocked++;
    } else if (action === 1) {
      const id = leaves[random(leaves.length)].sessionId;
      if (id) {
        root = normalizeToConstrained(removeSessionFromTree(root, id), max);
        model.delete(id);
        operations.removed++;
      }
    } else if (root && leaves.length > 1) {
      root = swapLeafSessions(root, leaves[0].id, leaves[leaves.length - 1].id);
      operations.swapped++;
    }
    const actual = getLeaves(root);
    expect(isConstrainedLayout(root, max)).toBe(true);
    expect(new Set(actual.map(leaf => leaf.id)).size).toBe(actual.length);
    expect(actual.length).toBeLessThanOrEqual(max);
    expect(actual.filter(leaf => leaf.sessionId).map(leaf => leaf.sessionId).sort()).toEqual([...model].sort());
  }
  expect(operations.added).toBeGreaterThan(0);
  expect(operations.removed).toBeGreaterThan(0);
  expect(operations.blocked).toBeGreaterThan(0);
  if (max > 1) expect(operations.swapped).toBeGreaterThan(0);
});
