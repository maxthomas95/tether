import { describe, expect, it } from 'vitest';
import type { LayoutNode } from '../../shared/layout-types';
import {
  getBroadcastSessionIds,
  pruneBroadcastPaneIds,
  type BroadcastSessionLike,
} from './broadcast-targets';
import { buildConstrainedLayout, getLeaves } from './layout-tree';

describe('broadcast input target helpers', () => {
  const sessions: BroadcastSessionLike[] = [
    { id: 's1', state: 'running' },
    { id: 's2', state: 'waiting' },
    { id: 's3', state: 'dead' },
    { id: 's4', state: 'stopped' },
  ];

  it('returns selected live sessions in layout order', () => {
    const root = buildConstrainedLayout(['s1', 's2', 's3', null])!;
    const leaves = getLeaves(root);
    const selected = new Set(leaves.map(l => l.id));

    expect(getBroadcastSessionIds(root, selected, sessions)).toEqual(['s1', 's2']);
  });

  it('deduplicates session ids if an invalid legacy layout has duplicates', () => {
    const root: LayoutNode = {
      type: 'split',
      id: 'split-1',
      direction: 'horizontal',
      ratio: 0.5,
      children: [
        { type: 'leaf', id: 'pane-a', sessionId: 's1' },
        { type: 'leaf', id: 'pane-b', sessionId: 's1' },
      ],
    };

    expect(getBroadcastSessionIds(root, new Set(['pane-a', 'pane-b']), sessions)).toEqual(['s1']);
  });

  it('prunes dead, stopped, empty, and missing panes from the selection', () => {
    const root = buildConstrainedLayout(['s1', 's3', 's4', null])!;
    const leaves = getLeaves(root);
    const selected = new Set([...leaves.map(l => l.id), 'missing-pane']);

    expect(Array.from(pruneBroadcastPaneIds(root, selected, sessions))).toEqual([leaves[0].id]);
  });

  it('returns an empty set when there is no layout', () => {
    expect(getBroadcastSessionIds(null, new Set(['pane-a']), sessions)).toEqual([]);
    expect(Array.from(pruneBroadcastPaneIds(null, new Set(['pane-a']), sessions))).toEqual([]);
  });
});
