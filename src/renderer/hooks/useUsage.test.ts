// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useUsage } from './useUsage';

it('uses safe defaults after failed settings reads and refreshes budgets when settings change', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const get = vi.fn().mockRejectedValue(new Error('read unavailable'));
  const unsubscribe = vi.fn();
  vi.stubGlobal('electronAPI', { config: { get }, usage: {
    getAll: vi.fn().mockResolvedValue(null), onUpdate: () => unsubscribe,
  } });
  let state!: ReturnType<typeof useUsage>;
  function Harness() { state = useUsage(); return null; }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(createElement(Harness)));
    expect(state.budgetThresholds).toEqual({ dailyUsd: null, weeklyUsd: null });
    expect(state.cliToolBreakdownEnabled).toBe(false);
    const settings: Record<string, string> = { globalUsageEnabled: 'false', cliToolBreakdownEnabled: 'true',
      'usageBudget.dailyUsd': '10', 'usageBudget.weeklyUsd': '50' };
    get.mockImplementation(async key => settings[key as string]);
    await act(async () => window.dispatchEvent(new Event('tether:settings-changed')));
    expect(state.budgetThresholds).toEqual({ dailyUsd: 10, weeklyUsd: 50 });
    expect(state.enabled).toBe(false);
    expect(state.usage).toBeNull();
    expect(unsubscribe).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
