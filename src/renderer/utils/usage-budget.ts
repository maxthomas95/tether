import type { DailyUsage } from '../../shared/types';
import { dailyRollups, weeklyRollups } from './usage-rollups';

export type UsageBudgetPeriod = 'daily' | 'weekly';

export interface UsageBudgetThresholds {
  dailyUsd: number | null;
  weeklyUsd: number | null;
}

export interface UsageBudgetStatus {
  period: UsageBudgetPeriod;
  periodKey: string;
  cost: number;
  threshold: number | null;
  crossed: boolean;
}

export interface UsageBudgetAlert {
  period: UsageBudgetPeriod;
  periodKey: string;
  cost: number;
  threshold: number;
}

export interface UsageBudgetMarkers {
  daily?: string | null;
  weekly?: string | null;
}

export function parseBudgetThreshold(value: string | null | undefined): number | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

export function computeUsageBudgetStatus(
  daily: ReadonlyArray<DailyUsage>,
  thresholds: UsageBudgetThresholds,
  todayRef?: Date,
): { daily: UsageBudgetStatus; weekly: UsageBudgetStatus } {
  const [today] = dailyRollups(daily, 1, todayRef);
  const [week] = weeklyRollups(daily, 1, todayRef);

  return {
    daily: {
      period: 'daily',
      periodKey: today.key,
      cost: today.totalCost,
      threshold: thresholds.dailyUsd,
      crossed: thresholds.dailyUsd !== null && today.totalCost >= thresholds.dailyUsd,
    },
    weekly: {
      period: 'weekly',
      periodKey: week.key,
      cost: week.totalCost,
      threshold: thresholds.weeklyUsd,
      crossed: thresholds.weeklyUsd !== null && week.totalCost >= thresholds.weeklyUsd,
    },
  };
}

export function usageBudgetAlertsDue(
  status: { daily: UsageBudgetStatus; weekly: UsageBudgetStatus },
  markers: UsageBudgetMarkers,
): UsageBudgetAlert[] {
  const alerts: UsageBudgetAlert[] = [];
  for (const period of ['daily', 'weekly'] as const) {
    const row = status[period];
    if (!row.crossed || row.threshold === null) continue;
    if (markers[period] === row.periodKey) continue;
    alerts.push({
      period,
      periodKey: row.periodKey,
      cost: row.cost,
      threshold: row.threshold,
    });
  }
  return alerts;
}
