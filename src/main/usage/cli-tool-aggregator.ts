import type { SessionUsage, CliToolUsage } from '../../shared/types';

/**
 * Group per-session usage by `cliTool`. Every SessionUsage carries a
 * cliTool, so there is no null/unattributed bucket here.
 *
 * Returned rows are sorted by totalCost desc; ties break by sessionCount
 * desc and finally by cliTool string asc so the order is stable across
 * snapshots when costs are equal (e.g. all zero on a fresh install).
 */
export function aggregateByCliTool(sessions: ReadonlyArray<SessionUsage>): CliToolUsage[] {
  const buckets = new Map<string, CliToolUsage>();
  for (const s of sessions) {
    let row = buckets.get(s.cliTool);
    if (!row) {
      row = { cliTool: s.cliTool, totalCost: 0, sessionCount: 0, totalTokens: 0 };
      buckets.set(s.cliTool, row);
    }
    row.totalCost += s.totalCost;
    row.sessionCount += 1;
    row.totalTokens += s.inputTokens + s.outputTokens + s.cacheCreationTokens + s.cacheReadTokens;
  }
  const out = Array.from(buckets.values());
  out.sort((a, b) => {
    if (a.totalCost !== b.totalCost) return b.totalCost - a.totalCost;
    if (a.sessionCount !== b.sessionCount) return b.sessionCount - a.sessionCount;
    return a.cliTool.localeCompare(b.cliTool);
  });
  return out;
}
