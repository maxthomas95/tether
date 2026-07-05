import React, { useEffect, useMemo, useRef } from 'react';
import { useUsage } from '../../hooks/useUsage';
import type { CliToolUsage, DailyUsage, EnvironmentInfo, EnvironmentUsage } from '../../../shared/types';
import { CLI_TOOL_REGISTRY } from '../../../shared/cli-tools';
import type { CliToolId } from '../../../shared/cli-tools';
import { formatCost, formatTokens } from '../../utils/usage-format';
import {
  computeUsageBudgetStatus,
  usageBudgetAlertsDue,
  type UsageBudgetAlert,
} from '../../utils/usage-budget';

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Build last N days as an ordered array (oldest → newest), filling gaps with zeros. */
function fillLastNDays(daily: DailyUsage[], n: number): DailyUsage[] {
  const map = new Map(daily.map(d => [d.date, d]));
  const out: DailyUsage[] = [];
  const today = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const date = d.toISOString().slice(0, 10);
    out.push(map.get(date) ?? {
      date,
      inputTokens: 0, outputTokens: 0,
      cacheCreationTokens: 0, cacheReadTokens: 0,
      totalCost: 0, sessionCount: 0,
    });
  }
  return out;
}

function sumWindow(days: DailyUsage[]): { cost: number; tokens: number; sessions: number } {
  let cost = 0, tokens = 0, sessions = 0;
  for (const d of days) {
    cost += d.totalCost;
    tokens += d.inputTokens + d.outputTokens + d.cacheCreationTokens + d.cacheReadTokens;
    sessions += d.sessionCount;
  }
  return { cost, tokens, sessions };
}

interface GlobalUsageFooterProps {
  onOpenHistory?: () => void;
  onBudgetCrossed?: (alert: UsageBudgetAlert) => void;
  /**
   * Environments list for resolving display names in the per-environment
   * tooltip section. Pass-through from App; if omitted, env rows render as
   * "<id>" verbatim.
   */
  environments?: EnvironmentInfo[];
}

/** Format a single per-env tooltip row. */
function formatEnvRow(row: EnvironmentUsage, envMap: Map<string, string>): string {
  const id = row.environmentId;
  let name: string;
  if (id === null) {
    name = 'Unattributed';
  } else {
    name = envMap.get(id) ?? 'Deleted env';
  }
  return `  ${name.padEnd(16, ' ').slice(0, 16)} ${formatCost(row.totalCost).padStart(8, ' ')}  (${row.sessionCount} ${row.sessionCount === 1 ? 'session' : 'sessions'})`;
}

/** Resolve a CLI tool id to a human-friendly display name. */
function cliToolName(id: CliToolId): string {
  return CLI_TOOL_REGISTRY[id]?.displayName ?? id;
}

/** Format a single per-CLI-tool tooltip row. */
function formatCliToolRow(row: CliToolUsage): string {
  const name = cliToolName(row.cliTool);
  const sessions = `${row.sessionCount} ${row.sessionCount === 1 ? 'session' : 'sessions'}`;
  return `  ${name.padEnd(16, ' ').slice(0, 16)} ${formatCost(row.totalCost).padStart(8, ' ')}  (${sessions}, ${formatTokens(row.totalTokens)} tokens)`;
}

interface CliToolTodaySplit {
  cliTool: CliToolId;
  cost: number;
  tokens: number;
}

/**
 * Per-tool spend for "today" (UTC date matches `today`). We walk the raw
 * session rows because the daily aggregate is collapsed across tools.
 * Sessions with no `lastMessageAt` (never had activity) are skipped.
 */
function computeTodayByCliTool(
  sessions: Record<string, import('../../../shared/types').SessionUsage>,
  today: string,
): CliToolTodaySplit[] {
  const buckets = new Map<CliToolId, CliToolTodaySplit>();
  for (const s of Object.values(sessions)) {
    if (!s.lastMessageAt) continue;
    if (s.lastMessageAt.slice(0, 10) !== today) continue;
    let row = buckets.get(s.cliTool);
    if (!row) {
      row = { cliTool: s.cliTool, cost: 0, tokens: 0 };
      buckets.set(s.cliTool, row);
    }
    row.cost += s.totalCost;
    row.tokens += s.inputTokens + s.outputTokens + s.cacheCreationTokens + s.cacheReadTokens;
  }
  const out = Array.from(buckets.values());
  out.sort((a, b) => {
    if (a.cost !== b.cost) return b.cost - a.cost;
    return a.cliTool.localeCompare(b.cliTool);
  });
  return out;
}

export function GlobalUsageFooter({ onOpenHistory, onBudgetCrossed, environments }: GlobalUsageFooterProps = {}) {
  const { usage, enabled, cliToolBreakdownEnabled, budgetThresholds } = useUsage();
  const inFlightAlerts = useRef<Set<string>>(new Set());
  const announcedAlerts = useRef<Set<string>>(new Set());

  const budgetStatus = useMemo(
    () => usage ? computeUsageBudgetStatus(usage.daily, budgetThresholds) : null,
    [usage, budgetThresholds],
  );

  useEffect(() => {
    if (!enabled || !budgetStatus || !onBudgetCrossed) return;
    let cancelled = false;
    const markerKeys = {
      daily: 'usageBudget.lastDailyWarningPeriod',
      weekly: 'usageBudget.lastWeeklyWarningPeriod',
    };

    Promise.all([
      window.electronAPI.config.get(markerKeys.daily).catch(() => null),
      window.electronAPI.config.get(markerKeys.weekly).catch(() => null),
    ]).then(([dailyMarker, weeklyMarker]) => {
      if (cancelled) return;
      const due = usageBudgetAlertsDue(budgetStatus, { daily: dailyMarker, weekly: weeklyMarker });
      for (const alert of due) {
        const inFlightKey = `${alert.period}:${alert.periodKey}`;
        if (inFlightAlerts.current.has(inFlightKey)) continue;
        if (announcedAlerts.current.has(inFlightKey)) continue;
        inFlightAlerts.current.add(inFlightKey);
        announcedAlerts.current.add(inFlightKey);
        try {
          onBudgetCrossed(alert);
        } catch {
          // UI alert callbacks are best-effort; marker persistence still prevents loops.
        }
        window.electronAPI.config.set(markerKeys[alert.period], alert.periodKey)
          .catch(() => {})
          .finally(() => {
            inFlightAlerts.current.delete(inFlightKey);
          });
      }
    });

    return () => { cancelled = true; };
  }, [enabled, budgetStatus, onBudgetCrossed]);

  if (!enabled || !usage || !budgetStatus) return null;

  const envMap = new Map<string, string>();
  for (const env of environments ?? []) envMap.set(env.id, env.name);

  const today = todayDate();
  const last7 = fillLastNDays(usage.daily, 7);
  const last30 = fillLastNDays(usage.daily, 30);
  const todayData = last7[last7.length - 1];
  const week = sumWindow(last7);
  const month = sumWindow(last30);

  // Find max cost in last 7 days for sparkline scaling
  const maxCost = Math.max(...last7.map(d => d.totalCost), 0.001);

  // Tooltip
  const dayList = last7
    .slice()
    .reverse()
    .map(d => `  ${d.date}: ${formatCost(d.totalCost)} (${d.sessionCount} sess)`)
    .join('\n');

  // Per-environment all-time breakdown. The aggregate already arrives sorted
  // by cost desc; we cap the displayed rows to keep the tooltip manageable
  // and surface a "+N more" line when truncated.
  const envRows = usage.byEnvironment ?? [];
  const ENV_MAX_ROWS = 6;
  const envLines: string[] = [];
  if (envRows.length > 0) {
    envLines.push('', 'By environment (all-time):');
    for (const r of envRows.slice(0, ENV_MAX_ROWS)) envLines.push(formatEnvRow(r, envMap));
    if (envRows.length > ENV_MAX_ROWS) envLines.push(`  …and ${envRows.length - ENV_MAX_ROWS} more`);
  }

  // Per-CLI-tool all-time breakdown. Mirrors the env section. Gated on the
  // `cliToolBreakdownEnabled` setting (default off).
  const cliToolRows = usage.byCliTool ?? [];
  const CLI_MAX_ROWS = 6;
  const cliToolLines: string[] = [];
  if (cliToolBreakdownEnabled && cliToolRows.length > 0) {
    cliToolLines.push('', 'By CLI tool (all-time):');
    for (const r of cliToolRows.slice(0, CLI_MAX_ROWS)) cliToolLines.push(formatCliToolRow(r));
    if (cliToolRows.length > CLI_MAX_ROWS) cliToolLines.push(`  …and ${cliToolRows.length - CLI_MAX_ROWS} more`);
  }

  // Today-by-CLI split. Derived from raw sessions (not the daily aggregate)
  // because the daily rollup is collapsed across tools. Only surfaces when
  // the per-tool breakdown setting is on AND 2+ tools had activity today.
  const todayByCliTool = cliToolBreakdownEnabled
    ? computeTodayByCliTool(usage.sessions, today)
    : [];
  const showTodayByCliTool =
    cliToolBreakdownEnabled
    && todayByCliTool.filter(r => r.cost > 0 || r.tokens > 0).length >= 2;

  const tooltip = [
    `Today:    ${formatCost(todayData.totalCost)}  (${todayData.sessionCount} sessions)`,
    `7 days:   ${formatCost(week.cost)}  (${week.sessions} sessions, ${formatTokens(week.tokens)} tokens)`,
    `30 days:  ${formatCost(month.cost)}  (${month.sessions} sessions, ${formatTokens(month.tokens)} tokens)`,
    `All-time: ${formatCost(usage.totalCost)}`,
    ...(budgetStatus.daily.threshold !== null || budgetStatus.weekly.threshold !== null
      ? [
          '',
          'Budget guardrails:',
          ...(budgetStatus.daily.threshold !== null
            ? [`  Daily:  ${formatCost(budgetStatus.daily.cost)} / ${formatCost(budgetStatus.daily.threshold)}${budgetStatus.daily.crossed ? ' crossed' : ''}`]
            : []),
          ...(budgetStatus.weekly.threshold !== null
            ? [`  Weekly: ${formatCost(budgetStatus.weekly.cost)} / ${formatCost(budgetStatus.weekly.threshold)}${budgetStatus.weekly.crossed ? ' crossed' : ''}`]
            : []),
        ]
      : []),
    '',
    'Last 7 days:',
    dayList,
    ...envLines,
    ...cliToolLines,
    '',
    '(API-equivalent cost — your subscription covers this usage)',
  ].join('\n');

  const tooltipWithHint = onOpenHistory ? `${tooltip}\n\nClick for full history.` : tooltip;
  const budgetCrossed = budgetStatus.daily.crossed || budgetStatus.weekly.crossed;

  return (
    <button
      type="button"
      className={`global-usage-footer ${budgetCrossed ? 'global-usage-footer--budget-warning' : ''}`}
      title={tooltipWithHint}
      onClick={onOpenHistory}
      disabled={!onOpenHistory}
    >
      <div className="global-usage-row">
        <span className="global-usage-label">Today</span>
        <span className="global-usage-value">{formatCost(todayData.totalCost)}</span>
      </div>
      {showTodayByCliTool && (
        <div className="global-usage-row global-usage-row--breakdown">
          <span className="global-usage-breakdown">
            {todayByCliTool.map((r, i) => (
              <React.Fragment key={r.cliTool}>
                {i > 0 && <span className="global-usage-breakdown-sep">·</span>}
                <span className="global-usage-breakdown-item">
                  <span className="global-usage-breakdown-name">{cliToolName(r.cliTool)}</span>
                  {' '}
                  {formatCost(r.cost)}
                  {' · '}
                  {formatTokens(r.tokens)}
                </span>
              </React.Fragment>
            ))}
          </span>
        </div>
      )}
      <div className="global-usage-row">
        <span className="global-usage-label">7d</span>
        <div className="global-usage-sparkline">
          {last7.map((d, i) => {
            const heightPct = Math.max(2, (d.totalCost / maxCost) * 100);
            const isToday = d.date === today;
            return (
              <div
                key={i}
                className={`global-usage-spark-bar ${isToday ? 'global-usage-spark-bar--today' : ''}`}
                style={{ height: `${heightPct}%`, '--bar-index': i } as React.CSSProperties}
              />
            );
          })}
        </div>
        <span className="global-usage-value">{formatCost(week.cost)}</span>
      </div>
    </button>
  );
}
