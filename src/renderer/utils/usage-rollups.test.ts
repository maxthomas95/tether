import { describe, expect, it } from 'vitest';
import { dailyRollups, weeklyRollups, monthlyRollups, windowSummary } from './usage-rollups';
import type { DailyUsage } from '../../shared/types';

// Saturday in UTC. dayOfWeekMon0 = 5 → that week's Monday is May 4 2026.
const TODAY = new Date(Date.UTC(2026, 4, 9));

function mkDay(date: string, totalCost: number, sessionCount = 1, tokens = 1000): DailyUsage {
  return {
    date,
    inputTokens: tokens,
    outputTokens: tokens,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalCost,
    sessionCount,
  };
}

describe('dailyRollups', () => {
  it('returns the requested number of days, most recent first', () => {
    const rows = dailyRollups([], 7, TODAY);
    expect(rows).toHaveLength(7);
    expect(rows[0].key).toBe('2026-05-09');
    expect(rows[6].key).toBe('2026-05-03');
  });

  it('fills missing days with zeros', () => {
    const rows = dailyRollups([mkDay('2026-05-08', 1.5)], 3, TODAY);
    expect(rows[0]).toMatchObject({ key: '2026-05-09', totalCost: 0, sessionCount: 0 });
    expect(rows[1]).toMatchObject({ key: '2026-05-08', totalCost: 1.5, sessionCount: 1 });
    expect(rows[2]).toMatchObject({ key: '2026-05-07', totalCost: 0 });
  });

  it('uses startDate === endDate === key for daily rows', () => {
    const [row] = dailyRollups([], 1, TODAY);
    expect(row.startDate).toBe(row.endDate);
    expect(row.startDate).toBe(row.key);
  });

  it('formats the label as "Mon D"', () => {
    const rows = dailyRollups([], 2, TODAY);
    expect(rows[0].label).toBe('May 9');
    expect(rows[1].label).toBe('May 8');
  });
});

describe('weeklyRollups', () => {
  it('anchors to ISO Monday and returns weeks most-recent first', () => {
    const rows = weeklyRollups([], 3, TODAY);
    expect(rows).toHaveLength(3);
    // Current week containing May 9 (Sat) → starts May 4 (Mon), ends May 10 (Sun)
    expect(rows[0]).toMatchObject({ startDate: '2026-05-04', endDate: '2026-05-10' });
    expect(rows[1]).toMatchObject({ startDate: '2026-04-27', endDate: '2026-05-03' });
    expect(rows[2]).toMatchObject({ startDate: '2026-04-20', endDate: '2026-04-26' });
  });

  it('sums all 7 days into the containing week', () => {
    const daily: DailyUsage[] = [
      mkDay('2026-05-04', 1, 1),
      mkDay('2026-05-05', 2, 1),
      mkDay('2026-05-08', 3, 2),
      mkDay('2026-05-10', 4, 1),
    ];
    const [thisWeek] = weeklyRollups(daily, 1, TODAY);
    expect(thisWeek.totalCost).toBeCloseTo(10);
    expect(thisWeek.sessionCount).toBe(5);
  });

  it('does not bleed sessions from adjacent weeks', () => {
    // May 3 (Sun) is the previous week; May 4 (Mon) is this week. Two days, two
    // distinct weeks — neither should pick up the other's row.
    const daily: DailyUsage[] = [
      mkDay('2026-05-03', 5, 1),
      mkDay('2026-05-04', 7, 1),
    ];
    const [thisWeek, lastWeek] = weeklyRollups(daily, 2, TODAY);
    expect(thisWeek.totalCost).toBeCloseTo(7);
    expect(lastWeek.totalCost).toBeCloseTo(5);
  });

  it('labels the row as "Week of <Mon D>"', () => {
    const [first] = weeklyRollups([], 1, TODAY);
    expect(first.label).toBe('Week of May 4');
  });
});

describe('monthlyRollups', () => {
  it('returns calendar months, most recent first', () => {
    const rows = monthlyRollups([], 3, TODAY);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ key: '2026-05', startDate: '2026-05-01', endDate: '2026-05-31' });
    expect(rows[1]).toMatchObject({ key: '2026-04', startDate: '2026-04-01', endDate: '2026-04-30' });
    expect(rows[2]).toMatchObject({ key: '2026-03', startDate: '2026-03-01', endDate: '2026-03-31' });
  });

  it('sums all days within a calendar month', () => {
    const daily: DailyUsage[] = [
      mkDay('2026-04-01', 1),
      mkDay('2026-04-30', 2),
      mkDay('2026-05-01', 4),
    ];
    const [may, apr] = monthlyRollups(daily, 2, TODAY);
    expect(may.totalCost).toBeCloseTo(4);
    expect(apr.totalCost).toBeCloseTo(3);
  });

  it('handles year boundaries', () => {
    const earlyJan = new Date(Date.UTC(2026, 0, 5));
    const rows = monthlyRollups([], 2, earlyJan);
    expect(rows[0].key).toBe('2026-01');
    expect(rows[1].key).toBe('2025-12');
    expect(rows[1]).toMatchObject({ startDate: '2025-12-01', endDate: '2025-12-31' });
  });

  it('handles February correctly across leap years', () => {
    // 2024 is a leap year (Feb has 29 days).
    const mar2024 = new Date(Date.UTC(2024, 2, 1));
    const [, feb] = monthlyRollups([], 2, mar2024);
    expect(feb.endDate).toBe('2024-02-29');
  });
});

describe('windowSummary', () => {
  const daily: DailyUsage[] = [
    mkDay('2026-05-09', 1, 1, 100),
    mkDay('2026-05-08', 2, 1, 200),
    mkDay('2026-05-03', 5, 2, 500),
    mkDay('2026-04-15', 10, 3, 1000),
  ];

  it('today = just today\'s row', () => {
    const summary = windowSummary(daily, 'today', 99, TODAY);
    expect(summary.totalCost).toBeCloseTo(1);
    expect(summary.sessionCount).toBe(1);
    expect(summary.totalTokens).toBe(200); // input + output
  });

  it('7d = last 7 days inclusive', () => {
    const summary = windowSummary(daily, '7d', 99, TODAY);
    expect(summary.totalCost).toBeCloseTo(8); // 1 + 2 + 5
    expect(summary.sessionCount).toBe(4);
  });

  it('30d = last 30 days inclusive', () => {
    const summary = windowSummary(daily, '30d', 99, TODAY);
    // Today minus 29 days = 2026-04-10. The 2026-04-15 row is inside.
    expect(summary.totalCost).toBeCloseTo(18);
    expect(summary.sessionCount).toBe(7);
  });

  it('all = uses caller-supplied allTimeCost (not derived from daily)', () => {
    const summary = windowSummary(daily, 'all', 42.5, TODAY);
    expect(summary.totalCost).toBeCloseTo(42.5);
    // Tokens / sessions still come from daily
    expect(summary.sessionCount).toBe(7);
  });

  it('returns zero summary for empty daily input', () => {
    const summary = windowSummary([], '7d', 0, TODAY);
    expect(summary).toEqual({ totalCost: 0, totalTokens: 0, sessionCount: 0 });
  });
});
