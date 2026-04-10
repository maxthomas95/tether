import type { LayoutNode, LayoutLeaf, LayoutSplit, PaneId, DropZone } from '../../shared/layout-types';

export function generatePaneId(): PaneId {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

export function findLeaf(root: LayoutNode | null, paneId: PaneId): LayoutLeaf | null {
  if (!root) return null;
  if (root.type === 'leaf') {
    return root.id === paneId ? root : null;
  }
  return findLeaf(root.children[0], paneId) || findLeaf(root.children[1], paneId);
}

export function findParent(root: LayoutNode, childId: PaneId): LayoutSplit | null {
  if (root.type === 'leaf') return null;
  if (root.children[0].id === childId || root.children[1].id === childId) {
    return root;
  }
  return findParent(root.children[0], childId) || findParent(root.children[1], childId);
}

export function addPane(
  root: LayoutNode | null,
  targetPaneId: PaneId,
  sessionId: string,
  zone: DropZone,
): LayoutNode {
  if (!root) {
    return { type: 'leaf', id: generatePaneId(), sessionId };
  }

  return insertAtLeaf(root, targetPaneId, sessionId, zone);
}

function insertAtLeaf(
  node: LayoutNode,
  targetPaneId: PaneId,
  sessionId: string,
  zone: DropZone,
): LayoutNode {
  if (node.type === 'leaf') {
    if (node.id !== targetPaneId) return node;

    const newLeaf: LayoutLeaf = { type: 'leaf', id: generatePaneId(), sessionId };

    if (zone === 'center') {
      // Replace session in this leaf
      return { ...node, sessionId };
    }

    const direction: 'horizontal' | 'vertical' =
      zone === 'left' || zone === 'right' ? 'horizontal' : 'vertical';
    const isFirst = zone === 'left' || zone === 'top';

    const split: LayoutSplit = {
      type: 'split',
      id: generatePaneId(),
      direction,
      ratio: 0.5,
      children: isFirst ? [newLeaf, node] : [node, newLeaf],
    };
    return split;
  }

  // Recurse into split children
  return {
    ...node,
    children: [
      insertAtLeaf(node.children[0], targetPaneId, sessionId, zone),
      insertAtLeaf(node.children[1], targetPaneId, sessionId, zone),
    ],
  };
}

export function removePane(root: LayoutNode | null, paneId: PaneId): LayoutNode | null {
  if (!root) return null;
  if (root.type === 'leaf') {
    return root.id === paneId ? null : root;
  }

  // If one of the direct children is the target, replace this split with the sibling
  if (root.children[0].id === paneId) return root.children[1];
  if (root.children[1].id === paneId) return root.children[0];

  // Recurse into children
  const newFirst = removePane(root.children[0], paneId);
  const newSecond = removePane(root.children[1], paneId);

  // If a child was removed entirely (shouldn't happen with well-formed trees), return the other
  if (!newFirst) return newSecond;
  if (!newSecond) return newFirst;

  return {
    ...root,
    children: [newFirst, newSecond],
  };
}

export function updateRatio(root: LayoutNode, splitId: PaneId, newRatio: number): LayoutNode {
  if (root.type === 'leaf') return root;

  if (root.id === splitId) {
    return { ...root, ratio: newRatio };
  }

  return {
    ...root,
    children: [
      updateRatio(root.children[0], splitId, newRatio),
      updateRatio(root.children[1], splitId, newRatio),
    ],
  };
}

export function replaceSession(root: LayoutNode, paneId: PaneId, newSessionId: string): LayoutNode {
  if (root.type === 'leaf') {
    return root.id === paneId ? { ...root, sessionId: newSessionId } : root;
  }

  return {
    ...root,
    children: [
      replaceSession(root.children[0], paneId, newSessionId),
      replaceSession(root.children[1], paneId, newSessionId),
    ],
  };
}

export function getLeaves(root: LayoutNode | null): LayoutLeaf[] {
  if (!root) return [];
  if (root.type === 'leaf') return [root];
  return [...getLeaves(root.children[0]), ...getLeaves(root.children[1])];
}

/**
 * Find the neighboring pane in the given direction for keyboard navigation.
 * This walks up the tree to find a split in the matching axis, then descends
 * into the adjacent subtree to find the closest leaf.
 */
export function getAdjacentPane(
  root: LayoutNode,
  currentPaneId: PaneId,
  direction: 'left' | 'right' | 'up' | 'down',
): PaneId | null {
  // Build path from root to the target leaf
  const path = findPath(root, currentPaneId);
  if (!path || path.length === 0) return null;

  const axis: 'horizontal' | 'vertical' =
    direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical';
  const goFirst = direction === 'left' || direction === 'up';

  // Walk up the path from the leaf to find a split node in the correct axis
  // where the current pane is on the "wrong" side (so we can go to the other side)
  for (let i = path.length - 2; i >= 0; i--) {
    const node = path[i];
    if (node.type !== 'split') continue;
    if (node.direction !== axis) continue;

    const childOnPath = path[i + 1];
    const childIndex = node.children[0].id === childOnPath.id ? 0 : 1;

    // goFirst means we want to go toward index 0 (left/top), so current must be at index 1
    // !goFirst means we want to go toward index 1 (right/bottom), so current must be at index 0
    if (goFirst && childIndex === 1) {
      return getEdgeLeaf(node.children[0], goFirst ? 'last' : 'first', axis);
    }
    if (!goFirst && childIndex === 0) {
      return getEdgeLeaf(node.children[1], goFirst ? 'last' : 'first', axis);
    }
  }

  return null;
}

function findPath(root: LayoutNode, targetId: PaneId): LayoutNode[] | null {
  if (root.id === targetId) return [root];
  if (root.type === 'leaf') return null;

  for (const child of root.children) {
    const sub = findPath(child, targetId);
    if (sub) return [root, ...sub];
  }
  return null;
}

function getEdgeLeaf(node: LayoutNode, edge: 'first' | 'last', axis: 'horizontal' | 'vertical'): PaneId {
  if (node.type === 'leaf') return node.id;
  if (node.direction === axis) {
    const child = edge === 'first' ? node.children[0] : node.children[1];
    return getEdgeLeaf(child, edge, axis);
  }
  return getEdgeLeaf(node.children[0], edge, axis);
}

/**
 * Remove all leaves showing a given session. Returns the new root or null.
 */
export function removeSessionFromTree(root: LayoutNode | null, sessionId: string): LayoutNode | null {
  if (!root) return null;
  const leaves = getLeaves(root).filter(l => l.sessionId === sessionId);
  let current: LayoutNode | null = root;
  for (const leaf of leaves) {
    current = removePane(current, leaf.id);
    if (!current) break;
  }
  return current;
}
