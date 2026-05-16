import type { LayoutNode, PaneId } from '../../shared/layout-types';
import type { SessionState } from '../../shared/types';
import { getLeaves } from './layout-tree';

export interface BroadcastSessionLike {
  id: string;
  state: SessionState;
}

export function isBroadcastableSession(session: BroadcastSessionLike | undefined): boolean {
  return !!session && session.state !== 'dead' && session.state !== 'stopped';
}

export function getBroadcastSessionIds(
  root: LayoutNode | null,
  paneIds: ReadonlySet<PaneId>,
  sessions: ReadonlyArray<BroadcastSessionLike>,
): string[] {
  if (!root || paneIds.size === 0) return [];

  const sessionById = new Map(sessions.map(s => [s.id, s]));
  const seen = new Set<string>();
  const out: string[] = [];

  for (const leaf of getLeaves(root)) {
    if (!paneIds.has(leaf.id) || !leaf.sessionId) continue;
    if (!isBroadcastableSession(sessionById.get(leaf.sessionId))) continue;
    if (seen.has(leaf.sessionId)) continue;
    seen.add(leaf.sessionId);
    out.push(leaf.sessionId);
  }

  return out;
}

export function pruneBroadcastPaneIds(
  root: LayoutNode | null,
  paneIds: ReadonlySet<PaneId>,
  sessions: ReadonlyArray<BroadcastSessionLike>,
): Set<PaneId> {
  if (!root || paneIds.size === 0) return new Set();

  const sessionById = new Map(sessions.map(s => [s.id, s]));
  const valid = new Set<PaneId>();

  for (const leaf of getLeaves(root)) {
    if (!leaf.sessionId || !isBroadcastableSession(sessionById.get(leaf.sessionId))) continue;
    if (paneIds.has(leaf.id)) valid.add(leaf.id);
  }

  return valid;
}
