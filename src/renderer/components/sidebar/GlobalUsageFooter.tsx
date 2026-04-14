import React from 'react';
import { useUsage } from '../../hooks/useUsage';
import type { DailyUsage } from '../../../shared/types';

function formatCost(cost: number): string {
  if (cost === 0) return '$0';
  if (cost < 0.01) return '<$0.01';
  if (cost >= 1000) return `$${(cost / 1000).toFixed(1)}k`;
  if (cost >= 100) return `$${cost.toFixed(0)}`;
  return `$${cost.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n === 0) return '0';
  if (n < 1000) return n.toString();
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

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

export function GlobalUsageFooter() {
  const { usage, enabled } = useUsage();

  if (!enabled || !usage) return null;

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
  const tooltip = [
    `Today:    ${formatCost(todayData.totalCost)}  (${todayData.sessionCount} sessions)`,
    `7 days:   ${formatCost(week.cost)}  (${week.sessions} sessions, ${formatTokens(week.tokens)} tokens)`,
    `30 days:  ${formatCost(month.cost)}  (${month.sessions} sessions, ${formatTokens(month.tokens)} tokens)`,
    `All-time: ${formatCost(usage.totalCost)}`,
    '',
    'Last 7 days:',
    dayList,
    '',
    '(API-equivalent cost — your subscription covers this usage)',
  ].join('\n');

  return (
    <div className="global-usage-footer" title={tooltip}>
      <div className="global-usage-row">
        <span className="global-usage-label">Today</span>
        <span className="global-usage-value">{formatCost(todayData.totalCost)}</span>
      </div>
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
                style={{ height: `${heightPct}%` }}
              />
            );
          })}
        </div>
        <span className="global-usage-value">{formatCost(week.cost)}</span>
      </div>
    </div>
  );
}
