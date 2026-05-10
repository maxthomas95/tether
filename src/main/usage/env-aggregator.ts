import type { SessionUsage, EnvironmentUsage } from '../../shared/types';

/**
 * Group per-session usage by `environmentId`. Sessions with no
 * environmentId (backfilled, or created before this feature shipped)
 * collapse into a single bucket with `environmentId: null` — the renderer
 * surfaces this as "Unattributed".
 *
 * Returned rows are sorted by totalCost desc; ties break by sessionCount
 * desc and finally by environmentId asc so the order is stable across
 * snapshots when costs are equal (e.g. all zero on a fresh install).
 */
export function aggregateByEnvironment(sessions: ReadonlyArray<SessionUsage>): EnvironmentUsage[] {
  const buckets = new Map<string | null, EnvironmentUsage>();
  for (const s of sessions) {
    const id = s.environmentId ?? null;
    let row = buckets.get(id);
    if (!row) {
      row = { environmentId: id, totalCost: 0, sessionCount: 0, totalTokens: 0 };
      buckets.set(id, row);
    }
    row.totalCost += s.totalCost;
    row.sessionCount += 1;
    row.totalTokens += s.inputTokens + s.outputTokens + s.cacheCreationTokens + s.cacheReadTokens;
  }
  const out = Array.from(buckets.values());
  out.sort((a, b) => {
    if (a.totalCost !== b.totalCost) return b.totalCost - a.totalCost;
    if (a.sessionCount !== b.sessionCount) return b.sessionCount - a.sessionCount;
    const ai = a.environmentId ?? '￿'; // null sorts last on tie
    const bi = b.environmentId ?? '￿';
    return ai.localeCompare(bi);
  });
  return out;
}
