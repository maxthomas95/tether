import type { DailyUsage, DailyCliToolUsage } from '../../shared/types';
import type { CliToolId } from '../../shared/cli-tools';

export interface RollupRow {
  /** Stable key — ISO date for daily, ISO date of Monday for weekly, YYYY-MM for monthly. */
  key: string;
  /** Human label, e.g. "May 9", "Week of May 4", "May 2026". English-only matches the rest of the UI. */
  label: string;
  /** Inclusive start (YYYY-MM-DD, UTC). */
  startDate: string;
  /** Inclusive end (YYYY-MM-DD, UTC). Equals startDate for daily rows. */
  endDate: string;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  sessionCount: number;
  /**
   * Per-CLI-tool breakdown summed across every day contributing to this row.
   * Sorted by totalCost desc, tie-break on cliTool asc. Omitted (undefined)
   * when no contributing day had a `byCliTool` field.
   */
  byCliTool?: DailyCliToolUsage[];
}

export type WindowKind = 'today' | '7d' | '30d' | 'all';

export interface WindowSummary {
  totalCost: number;
  totalTokens: number;
  sessionCount: number;
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function utcToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addUTCDays(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n));
}

/** Mon = 0 … Sun = 6. ISO 8601 week boundary. */
function dayOfWeekMon0(d: Date): number {
  return (d.getUTCDay() + 6) % 7;
}

function indexByDate(daily: ReadonlyArray<DailyUsage>): Map<string, DailyUsage> {
  return new Map(daily.map(d => [d.date, d]));
}

function formatDayLabel(d: Date): string {
  return `${SHORT_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function formatMonthLabel(d: Date): string {
  return `${SHORT_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function emptyRow(key: string, label: string, startDate: string, endDate: string): RollupRow {
  return {
    key, label, startDate, endDate,
    totalCost: 0,
    inputTokens: 0, outputTokens: 0,
    cacheCreationTokens: 0, cacheReadTokens: 0,
    sessionCount: 0,
  };
}

function addInto(target: RollupRow, source: DailyUsage, toolAcc?: Map<CliToolId, DailyCliToolUsage>): void {
  target.totalCost += source.totalCost;
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheCreationTokens += source.cacheCreationTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.sessionCount += source.sessionCount;
  if (toolAcc && source.byCliTool) {
    for (const t of source.byCliTool) {
      let row = toolAcc.get(t.cliTool);
      if (!row) {
        row = {
          cliTool: t.cliTool,
          totalCost: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          sessionCount: 0,
        };
        toolAcc.set(t.cliTool, row);
      }
      row.totalCost += t.totalCost;
      row.inputTokens += t.inputTokens;
      row.outputTokens += t.outputTokens;
      row.cacheCreationTokens += t.cacheCreationTokens;
      row.cacheReadTokens += t.cacheReadTokens;
      row.sessionCount += t.sessionCount;
    }
  }
}

/** Sort + attach the accumulated per-tool map onto a row. No-op if empty. */
function finalizeByCliTool(target: RollupRow, toolAcc: Map<CliToolId, DailyCliToolUsage>): void {
  if (toolAcc.size === 0) return;
  const rows = Array.from(toolAcc.values());
  rows.sort((a, b) => {
    if (a.totalCost !== b.totalCost) return b.totalCost - a.totalCost;
    return a.cliTool.localeCompare(b.cliTool);
  });
  target.byCliTool = rows;
}

/** Last `days` daily rows, most recent first, missing days filled with zeros. */
export function dailyRollups(daily: ReadonlyArray<DailyUsage>, days: number, todayRef?: Date): RollupRow[] {
  const map = indexByDate(daily);
  const today = todayRef ?? utcToday();
  const out: RollupRow[] = [];
  for (let i = 0; i < days; i++) {
    const d = addUTCDays(today, -i);
    const key = toISODate(d);
    const row = emptyRow(key, formatDayLabel(d), key, key);
    const src = map.get(key);
    if (src) {
      const toolAcc = new Map<CliToolId, DailyCliToolUsage>();
      addInto(row, src, toolAcc);
      finalizeByCliTool(row, toolAcc);
    }
    out.push(row);
  }
  return out;
}

/** Last `weeks` ISO weeks (Mon → Sun), most recent first. */
export function weeklyRollups(daily: ReadonlyArray<DailyUsage>, weeks: number, todayRef?: Date): RollupRow[] {
  const map = indexByDate(daily);
  const today = todayRef ?? utcToday();
  const currentWeekStart = addUTCDays(today, -dayOfWeekMon0(today));
  const out: RollupRow[] = [];
  for (let w = 0; w < weeks; w++) {
    const start = addUTCDays(currentWeekStart, -7 * w);
    const end = addUTCDays(start, 6);
    const startKey = toISODate(start);
    const endKey = toISODate(end);
    const row = emptyRow(startKey, `Week of ${formatDayLabel(start)}`, startKey, endKey);
    const toolAcc = new Map<CliToolId, DailyCliToolUsage>();
    for (let i = 0; i < 7; i++) {
      const src = map.get(toISODate(addUTCDays(start, i)));
      if (src) addInto(row, src, toolAcc);
    }
    finalizeByCliTool(row, toolAcc);
    out.push(row);
  }
  return out;
}

/** Last `months` calendar months, most recent first. */
export function monthlyRollups(daily: ReadonlyArray<DailyUsage>, months: number, todayRef?: Date): RollupRow[] {
  const map = indexByDate(daily);
  const today = todayRef ?? utcToday();
  const firstOfThisMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const out: RollupRow[] = [];
  for (let m = 0; m < months; m++) {
    const start = new Date(Date.UTC(firstOfThisMonth.getUTCFullYear(), firstOfThisMonth.getUTCMonth() - m, 1));
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
    const startKey = toISODate(start);
    const endKey = toISODate(end);
    const key = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`;
    const row = emptyRow(key, formatMonthLabel(start), startKey, endKey);
    const toolAcc = new Map<CliToolId, DailyCliToolUsage>();
    for (let d = start; d.getUTCMonth() === start.getUTCMonth(); d = addUTCDays(d, 1)) {
      const src = map.get(toISODate(d));
      if (src) addInto(row, src, toolAcc);
    }
    finalizeByCliTool(row, toolAcc);
    out.push(row);
  }
  return out;
}

/**
 * Cost / tokens / sessions for a fixed window. `'all'` uses the caller-supplied
 * all-time cost (the tracked map's totalCost includes sessions whose
 * lastMessageAt is missing, which would otherwise be excluded by date-keyed
 * rollups).
 */
export function windowSummary(
  daily: ReadonlyArray<DailyUsage>,
  kind: WindowKind,
  allTimeCost: number,
  todayRef?: Date,
): WindowSummary {
  if (kind === 'all') {
    let tokens = 0, sessions = 0;
    for (const d of daily) {
      tokens += d.inputTokens + d.outputTokens + d.cacheCreationTokens + d.cacheReadTokens;
      sessions += d.sessionCount;
    }
    return { totalCost: allTimeCost, totalTokens: tokens, sessionCount: sessions };
  }
  const today = todayRef ?? utcToday();
  const days = kind === 'today' ? 1 : kind === '7d' ? 7 : 30;
  const map = indexByDate(daily);
  let cost = 0, tokens = 0, sessions = 0;
  for (let i = 0; i < days; i++) {
    const src = map.get(toISODate(addUTCDays(today, -i)));
    if (!src) continue;
    cost += src.totalCost;
    tokens += src.inputTokens + src.outputTokens + src.cacheCreationTokens + src.cacheReadTokens;
    sessions += src.sessionCount;
  }
  return { totalCost: cost, totalTokens: tokens, sessionCount: sessions };
}
