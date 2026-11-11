// @vitest-environment jsdom
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DailyUsage, EnvironmentInfo, UsageInfo } from '../../../shared/types';
import type { UsageBudgetThresholds } from '../../utils/usage-budget';
import { click, createView } from '../visibility.test-helper';

const hook = vi.hoisted(() => ({
  value: {
    usage: null as unknown, enabled: true, cliToolBreakdownEnabled: false,
    budgetThresholds: { dailyUsd: null, weeklyUsd: null } as { dailyUsd: number | null; weeklyUsd: number | null },
  },
}));
vi.mock('../../hooks/useUsage', () => ({ useUsage: () => hook.value }));

import { GlobalUsageFooter } from './GlobalUsageFooter';

// Midday UTC, so the local and UTC calendar dates agree wherever the suite runs.
const NOW = new Date('2026-03-11T12:00:00Z');
const TODAY = '2026-03-11';

function day(date: string, totalCost: number, extra: Partial<DailyUsage> = {}): DailyUsage {
  return { date, inputTokens: 1000, outputTokens: 500, cacheCreationTokens: 0, cacheReadTokens: 0, totalCost, sessionCount: 1, ...extra };
}

function usage(daily: DailyUsage[], extra: Partial<UsageInfo> = {}): UsageInfo {
  return { sessions: {}, daily, byEnvironment: [], byCliTool: [], totalCost: 42, lastUpdated: null, ...extra };
}

function setHook(next: UsageInfo | null, options: { enabled?: boolean; breakdown?: boolean; budget?: UsageBudgetThresholds } = {}) {
  hook.value = {
    usage: next, enabled: options.enabled ?? true, cliToolBreakdownEnabled: options.breakdown ?? false,
    budgetThresholds: options.budget ?? { dailyUsd: null, weeklyUsd: null },
  };
}

let view: ReturnType<typeof createView>;
const config = { get: vi.fn(), set: vi.fn() };
const footer = () => view.container.querySelector<HTMLButtonElement>('.global-usage-footer')!;
const values = () => [...view.container.querySelectorAll('.global-usage-value')].map(item => item.textContent);

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  view = createView();
  config.get.mockReset().mockResolvedValue(null);
  config.set.mockReset().mockResolvedValue(undefined);
  window.electronAPI = { config } as unknown as typeof window.electronAPI;
});
afterEach(async () => { vi.useRealTimers(); await view.dispose(); });

describe('GlobalUsageFooter', () => {
  it('stays out of the sidebar when usage is off or not loaded yet', async () => {
    setHook(usage([day(TODAY, 1)]), { enabled: false });
    await view.render(React.createElement(GlobalUsageFooter));
    expect(view.container.innerHTML).toBe('');

    setHook(null);
    await view.render(React.createElement(GlobalUsageFooter));
    expect(view.container.innerHTML).toBe('');
  });

  it("shows today's cost, the week total and a seven-day sparkline ending today", async () => {
    setHook(usage([day(TODAY, 2.5), day('2026-03-09', 7.5), day('2026-02-20', 100)]));
    const onOpenHistory = vi.fn();
    await view.render(React.createElement(GlobalUsageFooter, { onOpenHistory }));

    expect(values()).toEqual(['$2.50', '$10.00']);
    const bars = [...view.container.querySelectorAll<HTMLElement>('.global-usage-spark-bar')];
    expect(bars).toHaveLength(7);
    expect(bars.at(-1)?.className).toContain('global-usage-spark-bar--today');
    expect(bars.map(bar => bar.style.height)).toEqual(['2%', '2%', '2%', '2%', '100%', '2%', '33.33333333333333%']);

    expect(footer().title).toContain('30 days:  $110  (3 sessions');
    expect(footer().title).toContain('All-time: $42.00');
    expect(footer().title).toContain('Click for full history.');
    await click(footer());
    expect(onOpenHistory).toHaveBeenCalledOnce();
  });

  it('is a plain readout when there is no history to open', async () => {
    setHook(usage([]));
    await view.render(React.createElement(GlobalUsageFooter));

    expect(values()).toEqual(['$0', '$0']);
    expect(footer().disabled).toBe(true);
    expect(footer().title).not.toContain('Click for full history.');
  });

  it('counts a session once across the days it was active', async () => {
    setHook(usage([
      day(TODAY, 1, { sessionIds: ['s1', 's2'], sessionCount: 2 }),
      day('2026-03-10', 1, { sessionIds: ['s1'], sessionCount: 1 }),
    ]));
    await view.render(React.createElement(GlobalUsageFooter));

    expect(footer().title).toContain('7 days:   $2.00  (2 sessions');
  });

  it('names environments in the breakdown, including deleted and unattributed ones', async () => {
    const byEnvironment = [
      { environmentId: 'env-1', totalCost: 30, sessionCount: 2 },
      { environmentId: 'gone', totalCost: 8, sessionCount: 1 },
      { environmentId: null, totalCost: 4, sessionCount: 1 },
      ...Array.from({ length: 5 }, (_unused, index) => ({ environmentId: `extra-${index}`, totalCost: 1, sessionCount: 1 })),
    ] as UsageInfo['byEnvironment'];
    setHook(usage([day(TODAY, 1)], { byEnvironment }));
    const environments = [{ id: 'env-1', name: 'Linux VM' }] as EnvironmentInfo[];
    await view.render(React.createElement(GlobalUsageFooter, { environments }));

    const title = footer().title;
    expect(title).toContain('By environment (all-time):');
    expect(title).toMatch(/Linux VM\s+\$30\.00 {2}\(2 sessions\)/);
    expect(title).toMatch(/Deleted env\s+\$8\.00 {2}\(1 session\)/);
    expect(title).toMatch(/Unattributed\s+\$4\.00/);
    expect(title).toContain('…and 2 more');
  });

  it('splits today by CLI tool only when the setting is on and two tools were used', async () => {
    const tool = (cliTool: string, totalCost: number) => ({
      cliTool, totalCost, inputTokens: 2000, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, sessionCount: 1,
    });
    const byCliTool = [{ cliTool: 'claude', totalCost: 40, sessionCount: 3, totalTokens: 90_000 }] as UsageInfo['byCliTool'];
    const both = usage([day(TODAY, 3, { byCliTool: [tool('codex', 1), tool('claude', 2)] as DailyUsage['byCliTool'] })], { byCliTool });

    setHook(both);
    await view.render(React.createElement(GlobalUsageFooter));
    expect(view.container.querySelector('.global-usage-breakdown')).toBeNull();
    expect(footer().title).not.toContain('By CLI tool');

    setHook(both, { breakdown: true });
    await view.render(React.createElement(GlobalUsageFooter));
    const names = [...view.container.querySelectorAll('.global-usage-breakdown-name')].map(item => item.textContent);
    expect(names).toEqual(['Claude Code', 'Codex CLI']);
    expect(footer().title).toMatch(/By CLI tool \(all-time\):\n\s+Claude Code\s+\$40\.00 {2}\(3 sessions, /);

    setHook(usage([day(TODAY, 2, { byCliTool: [tool('claude', 2)] as DailyUsage['byCliTool'] })]), { breakdown: true });
    await view.render(React.createElement(GlobalUsageFooter));
    expect(view.container.querySelector('.global-usage-breakdown')).toBeNull();
  });

  it('warns once when a budget is crossed and records the period so it does not repeat', async () => {
    const onBudgetCrossed = vi.fn();
    const budget = { dailyUsd: 5, weeklyUsd: null };
    setHook(usage([day(TODAY, 6)]), { budget });
    await view.render(React.createElement(GlobalUsageFooter, { onBudgetCrossed }));
    await act(async () => { await Promise.resolve(); });

    expect(onBudgetCrossed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ period: 'daily', cost: 6, threshold: 5 }));
    const [markerKey, period] = config.set.mock.calls[0] as [string, string];
    expect(markerKey).toBe('usageBudget.lastDailyWarningPeriod');
    expect(footer().className).toContain('global-usage-footer--budget-warning');
    expect(footer().title).toContain('Daily:  $6.00 / $5.00 crossed');

    // A usage refresh in the same period, with the marker now stored, stays quiet.
    config.get.mockImplementation(async (name: string) => (name === markerKey ? period : null));
    setHook(usage([day(TODAY, 7)]), { budget });
    await view.render(React.createElement(GlobalUsageFooter, { onBudgetCrossed }));
    await act(async () => { await Promise.resolve(); });
    expect(onBudgetCrossed).toHaveBeenCalledOnce();
  });

  it('keeps the marker even when the alert callback throws, and stays calm under budget', async () => {
    const budget = { dailyUsd: 50, weeklyUsd: 5 };
    setHook(usage([day(TODAY, 6)]), { budget });
    const onBudgetCrossed = vi.fn(() => { throw new Error('toast failed'); });
    await view.render(React.createElement(GlobalUsageFooter, { onBudgetCrossed }));
    await act(async () => { await Promise.resolve(); });

    expect(onBudgetCrossed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ period: 'weekly' }));
    expect(config.set).toHaveBeenCalledWith('usageBudget.lastWeeklyWarningPeriod', expect.any(String));
    expect(footer().title).toContain('Daily:  $6.00 / $50.00\n');
  });
});
