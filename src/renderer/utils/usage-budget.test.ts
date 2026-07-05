import { describe, expect, it } from 'vitest';
import type { DailyUsage } from '../../shared/types';
import { computeUsageBudgetStatus, parseBudgetThreshold, usageBudgetAlertsDue } from './usage-budget';

const TODAY = new Date(Date.UTC(2026, 4, 9));

function mkDay(date: string, totalCost: number): DailyUsage {
  return {
    date,
    inputTokens: 100,
    outputTokens: 100,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalCost,
    sessionCount: 1,
  };
}

describe('parseBudgetThreshold', () => {
  it('treats blank, zero, negative, and invalid values as disabled', () => {
    expect(parseBudgetThreshold('')).toBeNull();
    expect(parseBudgetThreshold('  ')).toBeNull();
    expect(parseBudgetThreshold('0')).toBeNull();
    expect(parseBudgetThreshold('-1')).toBeNull();
    expect(parseBudgetThreshold('nope')).toBeNull();
    expect(parseBudgetThreshold(null)).toBeNull();
  });

  it('parses positive decimal dollar values', () => {
    expect(parseBudgetThreshold('1')).toBe(1);
    expect(parseBudgetThreshold(' 12.34 ')).toBe(12.34);
  });
});

describe('computeUsageBudgetStatus', () => {
  it('marks daily crossed for today in UTC', () => {
    const status = computeUsageBudgetStatus(
      [mkDay('2026-05-08', 99), mkDay('2026-05-09', 5)],
      { dailyUsd: 4.5, weeklyUsd: null },
      TODAY,
    );

    expect(status.daily).toMatchObject({
      periodKey: '2026-05-09',
      cost: 5,
      threshold: 4.5,
      crossed: true,
    });
  });

  it('uses the current ISO week and excludes adjacent weeks', () => {
    const status = computeUsageBudgetStatus(
      [
        mkDay('2026-05-03', 100),
        mkDay('2026-05-04', 2),
        mkDay('2026-05-09', 3),
        mkDay('2026-05-10', 4),
      ],
      { dailyUsd: null, weeklyUsd: 8.5 },
      TODAY,
    );

    expect(status.weekly).toMatchObject({
      periodKey: '2026-05-04',
      cost: 9,
      threshold: 8.5,
      crossed: true,
    });
  });

  it('does not cross disabled guardrails', () => {
    const status = computeUsageBudgetStatus(
      [mkDay('2026-05-09', 50)],
      { dailyUsd: null, weeklyUsd: null },
      TODAY,
    );

    expect(status.daily.crossed).toBe(false);
    expect(status.weekly.crossed).toBe(false);
    expect(usageBudgetAlertsDue(status, {})).toEqual([]);
  });
});

describe('usageBudgetAlertsDue', () => {
  it('returns an alert once per period based on persisted markers', () => {
    const status = computeUsageBudgetStatus(
      [mkDay('2026-05-09', 5)],
      { dailyUsd: 1, weeklyUsd: null },
      TODAY,
    );

    expect(usageBudgetAlertsDue(status, { daily: '2026-05-08' })).toEqual([
      { period: 'daily', periodKey: '2026-05-09', cost: 5, threshold: 1 },
    ]);
    expect(usageBudgetAlertsDue(status, { daily: '2026-05-09' })).toEqual([]);
  });

  it('returns both daily and weekly alerts when both crossed and unmarked', () => {
    const status = computeUsageBudgetStatus(
      [mkDay('2026-05-08', 3), mkDay('2026-05-09', 5)],
      { dailyUsd: 4, weeklyUsd: 7 },
      TODAY,
    );

    expect(usageBudgetAlertsDue(status, {})).toEqual([
      { period: 'daily', periodKey: '2026-05-09', cost: 5, threshold: 4 },
      { period: 'weekly', periodKey: '2026-05-04', cost: 8, threshold: 7 },
    ]);
  });
});
