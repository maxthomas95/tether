import type { EnvironmentInfo, RepoGroupPref, SessionInfo, SessionOrderPref } from '../../shared/types';

/**
 * The sidebar's ordering rules as pure functions, so the rendered list and
 * anything that addresses sessions "by position" (Ctrl+1..9) cannot drift.
 */

/** Sessions listed under an environment. A session with no environment belongs to the local one. */
export function sessionsForEnvironment(
  env: Pick<EnvironmentInfo, 'id' | 'type'>,
  sessions: SessionInfo[],
): SessionInfo[] {
  return sessions.filter(session => env.type === 'local'
    ? !session.environmentId || session.environmentId === env.id
    : session.environmentId === env.id);
}

/** Repo groups inside one environment: pinned first, then the saved order, then by path. */
export function sortRepoGroupEntries(
  entries: [string, SessionInfo[]][],
  envPrefs: RepoGroupPref[],
): [string, SessionInfo[]][] {
  const prefMap = new Map(envPrefs.map(pref => [pref.workingDir, pref]));
  return [...entries].sort((a, b) => {
    const prefA = prefMap.get(a[0]);
    const prefB = prefMap.get(b[0]);
    const pinnedA = prefA?.pinned ?? false;
    const pinnedB = prefB?.pinned ?? false;
    if (pinnedA !== pinnedB) return pinnedA ? -1 : 1;
    const orderA = prefA?.sortOrder ?? Infinity;
    const orderB = prefB?.sortOrder ?? Infinity;
    if (orderA !== orderB) return orderA - orderB;
    return a[0].localeCompare(b[0]);
  });
}

/**
 * Sessions inside one repo group in the user-saved order. Sessions the saved
 * order does not mention sink to the bottom, oldest first, so a fresh session
 * always lands after older ones.
 */
export function sortSessionsByPref(
  pref: SessionOrderPref | undefined,
  groupSessions: SessionInfo[],
): SessionInfo[] {
  if (!pref || pref.orderedIds.length === 0) return groupSessions;
  const indexById = new Map(pref.orderedIds.map((id, index) => [id, index]));
  return [...groupSessions].sort((a, b) => {
    const indexA = indexById.get(a.id) ?? Infinity;
    const indexB = indexById.get(b.id) ?? Infinity;
    if (indexA !== indexB) return indexA - indexB;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

/** Group an environment's sessions by working directory, in first-seen order. */
export function groupByWorkingDir(sessions: SessionInfo[]): [string, SessionInfo[]][] {
  const byDir = new Map<string, SessionInfo[]>();
  for (const session of sessions) {
    const group = byDir.get(session.workingDir);
    if (group) group.push(session);
    else byDir.set(session.workingDir, [session]);
  }
  return Array.from(byDir.entries());
}

/**
 * Every session in the order the sidebar lists them from top to bottom:
 * environments, then repo groups, then sessions. Collapsed groups still
 * count, so a session's position does not change when a group is folded.
 */
export function sidebarSessionOrder(
  environments: Pick<EnvironmentInfo, 'id' | 'type'>[],
  sessions: SessionInfo[],
  repoGroupPrefs: RepoGroupPref[],
  sessionOrderPrefs: SessionOrderPref[],
): SessionInfo[] {
  const ordered: SessionInfo[] = [];
  const seen = new Set<string>();
  for (const env of environments) {
    const groups = sortRepoGroupEntries(
      groupByWorkingDir(sessionsForEnvironment(env, sessions)),
      repoGroupPrefs.filter(pref => pref.environmentId === env.id),
    );
    for (const [workingDir, groupSessions] of groups) {
      const pref = sessionOrderPrefs.find(p => p.environmentId === env.id && p.workingDir === workingDir);
      for (const session of sortSessionsByPref(pref, groupSessions)) {
        if (seen.has(session.id)) continue;
        seen.add(session.id);
        ordered.push(session);
      }
    }
  }
  return ordered;
}
