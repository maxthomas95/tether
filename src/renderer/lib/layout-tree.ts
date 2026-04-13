import type { LayoutNode, LayoutLeaf, LayoutSplit, PaneId, DropZone } from '../../shared/layout-types';

type SplitDirection = LayoutSplit['direction'];

export function generatePaneId(): PaneId {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

export function clampMaxPanes(maxPanes: number): 1 | 2 | 4 {
  if (maxPanes <= 1) return 1;
  if (maxPanes <= 2) return 2;
  return 4;
}

function createLeaf(sessionId: string | null): LayoutLeaf {
  return { type: 'leaf', id: generatePaneId(), sessionId };
}

function createSplit(direction: SplitDirection, children: [LayoutNode, LayoutNode]): LayoutSplit {
  return {
    type: 'split',
    id: generatePaneId(),
    direction,
    ratio: 0.5,
    children,
  };
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

    const newLeaf = createLeaf(sessionId);

    if (zone === 'center') {
      // Replace session in this leaf
      return { ...node, sessionId };
    }

    const direction = getDirectionForZone(zone);
    const isFirst = isFirstZone(zone);

    return createSplit(direction, isFirst ? [newLeaf, node] : [node, newLeaf]);
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

function getDirectionForZone(zone: DropZone): SplitDirection {
  return zone === 'top' || zone === 'bottom' ? 'vertical' : 'horizontal';
}

function isFirstZone(zone: DropZone): boolean {
  return zone === 'left' || zone === 'top' || zone === 'top-left' || zone === 'bottom-left';
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

export function replaceSession(root: LayoutNode, paneId: PaneId, newSessionId: string | null): LayoutNode {
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

export function getLeafCount(root: LayoutNode | null): number {
  if (!root) return 0;
  if (root.type === 'leaf') return 1;
  return getLeafCount(root.children[0]) + getLeafCount(root.children[1]);
}

export function buildConstrainedLayout(
  sessions: (string | null)[],
  direction: SplitDirection = 'horizontal',
): LayoutNode | null {
  if (sessions.length === 0) return null;
  if (sessions.length === 1) return createLeaf(sessions[0]);

  if (sessions.length === 2) {
    return createSplit(direction, [
      createLeaf(sessions[0]),
      createLeaf(sessions[1]),
    ]);
  }

  const gridSessions = sessions.slice(0, 4);
  while (gridSessions.length < 4) {
    gridSessions.push(null);
  }

  // Row-major input: [top-left, top-right, bottom-left, bottom-right].
  // Canonical tree: horizontal split of two vertical column splits.
  return createSplit('horizontal', [
    createSplit('vertical', [
      createLeaf(gridSessions[0]),
      createLeaf(gridSessions[2]),
    ]),
    createSplit('vertical', [
      createLeaf(gridSessions[1]),
      createLeaf(gridSessions[3]),
    ]),
  ]);
}

export function addPaneConstrained(
  root: LayoutNode | null,
  newSessionId: string,
  maxPanes: number,
  focusedPaneId?: PaneId | null,
  zone: DropZone = 'right',
): { root: LayoutNode; newPaneId: PaneId } {
  const max = clampMaxPanes(maxPanes);

  if (!root) {
    const newRoot = createLeaf(newSessionId);
    return { root: newRoot, newPaneId: newRoot.id };
  }

  const leaves = getLeaves(root);
  const focusedLeaf = focusedPaneId ? leaves.find(l => l.id === focusedPaneId) : null;
  const emptyLeaf = focusedLeaf?.sessionId === null
    ? focusedLeaf
    : leaves.find(l => l.sessionId === null);

  if (emptyLeaf) {
    return {
      root: replaceSession(root, emptyLeaf.id, newSessionId),
      newPaneId: emptyLeaf.id,
    };
  }

  if (leaves.length >= max) {
    return { root, newPaneId: focusedLeaf?.id ?? leaves[0]?.id ?? root.id };
  }

  if (leaves.length === 1 && max >= 2) {
    const existingSessionId = leaves[0].sessionId;
    const direction = getDirectionForZone(zone);
    const sessions = isFirstZone(zone)
      ? [newSessionId, existingSessionId]
      : [existingSessionId, newSessionId];
    const newRoot = buildConstrainedLayout(sessions, direction)!;
    const newLeaf = getLeaves(newRoot).find(l => l.sessionId === newSessionId);
    return { root: newRoot, newPaneId: newLeaf?.id ?? newRoot.id };
  }

  if (leaves.length === 2 && max >= 4) {
    const sessions = getTwoPaneGridSessions(root, leaves, newSessionId, zone);
    const newRoot = buildConstrainedLayout(sessions)!;
    const newLeaf = getLeaves(newRoot).find(l => l.sessionId === newSessionId);
    return { root: newRoot, newPaneId: newLeaf?.id ?? newRoot.id };
  }

  const normalizedRoot = normalizeToConstrained(root, max, focusedPaneId) ?? root;
  return { root: normalizedRoot, newPaneId: focusedLeaf?.id ?? leaves[0]?.id ?? root.id };
}

export function normalizeToConstrained(
  root: LayoutNode | null,
  maxPanes: number,
  focusedPaneId?: PaneId | null,
): LayoutNode | null {
  if (!root) return null;

  const max = clampMaxPanes(maxPanes);
  const leaves = getLeavesForConstrainedOrder(root);
  if (leaves.length === 0) return null;

  const targetCount = getTargetLeafCount(leaves.length, max);
  const selected = selectLeavesForLimit(leaves, targetCount, focusedPaneId).map(l => l.sessionId);

  while (max === 4 && selected.length === 3) {
    selected.push(null);
  }

  const direction = getPreferredTwoPaneDirection(root);
  return buildConstrainedLayout(selected, direction);
}

function getTargetLeafCount(leafCount: number, maxPanes: 1 | 2 | 4): number {
  if (leafCount <= 1) return leafCount;
  if (maxPanes === 1) return 1;
  if (maxPanes === 2) return Math.min(leafCount, 2);
  if (leafCount === 2) return 2;
  return 4;
}

function getTwoPaneGridSessions(
  root: LayoutNode,
  leaves: LayoutLeaf[],
  newSessionId: string,
  zone: DropZone,
): (string | null)[] {
  const sessions: (string | null)[] = [null, null, null, null];

  if (root.type === 'split' && root.direction === 'vertical') {
    sessions[0] = leaves[0].sessionId;
    sessions[2] = leaves[1].sessionId;
  } else {
    sessions[0] = leaves[0].sessionId;
    sessions[1] = leaves[1].sessionId;
  }

  const preferredIndex = getGridIndexForZone(zone);
  const targetIndex = preferredIndex !== null && sessions[preferredIndex] === null
    ? preferredIndex
    : sessions.findIndex(sessionId => sessionId === null);

  if (targetIndex !== -1) {
    sessions[targetIndex] = newSessionId;
  }

  return sessions;
}

function getGridIndexForZone(zone: DropZone): number | null {
  switch (zone) {
    case 'top-left':
      return 0;
    case 'top-right':
      return 1;
    case 'bottom-left':
      return 2;
    case 'bottom-right':
      return 3;
    default:
      return null;
  }
}

function getLeavesForConstrainedOrder(root: LayoutNode): LayoutLeaf[] {
  if (root.type === 'split' && root.direction === 'horizontal') {
    const [left, right] = root.children;
    if (
      left.type === 'split'
      && right.type === 'split'
      && left.direction === 'vertical'
      && right.direction === 'vertical'
      && left.children[0].type === 'leaf'
      && left.children[1].type === 'leaf'
      && right.children[0].type === 'leaf'
      && right.children[1].type === 'leaf'
    ) {
      return [left.children[0], right.children[0], left.children[1], right.children[1]];
    }
  }

  return getLeaves(root);
}

function selectLeavesForLimit(
  leaves: LayoutLeaf[],
  limit: number,
  focusedPaneId?: PaneId | null,
): LayoutLeaf[] {
  if (leaves.length <= limit) return leaves;

  const focusedLeaf = focusedPaneId ? leaves.find(l => l.id === focusedPaneId) : null;
  const remaining = focusedLeaf ? leaves.filter(l => l.id !== focusedLeaf.id) : leaves;
  const nonEmpty = remaining.filter(l => l.sessionId !== null);
  const empty = remaining.filter(l => l.sessionId === null);
  const prioritized = focusedLeaf
    ? [focusedLeaf, ...nonEmpty, ...empty]
    : [...nonEmpty, ...empty];

  return prioritized.slice(0, limit);
}

function getPreferredTwoPaneDirection(root: LayoutNode): SplitDirection {
  if (root.type === 'split' && getLeafCount(root) === 2) {
    return root.direction;
  }
  return 'horizontal';
}

export function isConstrainedLayout(root: LayoutNode | null, maxPanes: number): boolean {
  if (!root) return true;

  const max = clampMaxPanes(maxPanes);
  const leafCount = getLeafCount(root);
  if (leafCount > max || leafCount === 0 || leafCount === 3) return false;

  if (leafCount === 1) return root.type === 'leaf';
  if (leafCount === 2) {
    return root.type === 'split'
      && isHalf(root.ratio)
      && root.children[0].type === 'leaf'
      && root.children[1].type === 'leaf';
  }

  return max === 4 && isCanonicalFourPaneGrid(root);
}

function isCanonicalFourPaneGrid(root: LayoutNode): boolean {
  if (root.type !== 'split' || root.direction !== 'horizontal' || !isHalf(root.ratio)) {
    return false;
  }

  const [left, right] = root.children;
  return left.type === 'split'
    && right.type === 'split'
    && left.direction === 'vertical'
    && right.direction === 'vertical'
    && isHalf(left.ratio)
    && isHalf(right.ratio)
    && left.children[0].type === 'leaf'
    && left.children[1].type === 'leaf'
    && right.children[0].type === 'leaf'
    && right.children[1].type === 'leaf';
}

function isHalf(ratio: number): boolean {
  return Math.abs(ratio - 0.5) < 0.0001;
}

export function swapLeafSessions(
  root: LayoutNode,
  sourcePaneId: PaneId,
  targetPaneId: PaneId,
): LayoutNode {
  const sourceLeaf = findLeaf(root, sourcePaneId);
  const targetLeaf = findLeaf(root, targetPaneId);
  if (!sourceLeaf || !targetLeaf) return root;

  const withSourceUpdated = replaceSession(root, sourcePaneId, targetLeaf.sessionId);
  return replaceSession(withSourceUpdated, targetPaneId, sourceLeaf.sessionId);
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
