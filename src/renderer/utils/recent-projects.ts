export interface RecentProject {
  workingDir: string;
  environmentId: string;
}

export const RECENT_PROJECT_LIMIT = 6;

/** Only location metadata is retained: no launch flags, variables, or transcripts. */
export function parseRecentProjects(value: string | null): RecentProject[] {
  try {
    const rows: unknown = JSON.parse(value ?? '[]');
    if (!Array.isArray(rows)) return [];
    return mergeRecentProjects([], rows.filter((row): row is RecentProject =>
      !!row && typeof row === 'object'
      && typeof row.workingDir === 'string' && row.workingDir.trim().length > 0 && row.workingDir.length <= 4096
      && typeof row.environmentId === 'string' && row.environmentId.length > 0 && row.environmentId.length <= 255));
  } catch {
    return [];
  }
}

/** The same directory on two environments remains two distinct launch choices. */
export function mergeRecentProjects(existing: RecentProject[], incoming: RecentProject[]): RecentProject[] {
  const seen = new Set<string>();
  return [...incoming, ...existing].filter(row => {
    const key = JSON.stringify([row.environmentId, row.workingDir]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, RECENT_PROJECT_LIMIT).map(({ workingDir, environmentId }) => ({ workingDir, environmentId }));
}
