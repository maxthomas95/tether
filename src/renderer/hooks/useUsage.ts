import { useState, useEffect } from 'react';
import type { UsageInfo } from '../../shared/types';
import { parseBudgetThreshold, type UsageBudgetThresholds } from '../utils/usage-budget';

/**
 * Subscribes to global usage updates (across all tracked sessions).
 * Returns null if disabled or no data yet.
 *
 * `cliToolBreakdownEnabled` is a separate, default-off toggle gating the
 * per-CLI-tool footer breakdown (visible "today" subline + tooltip section).
 */
export function useUsage(): { usage: UsageInfo | null; enabled: boolean; cliToolBreakdownEnabled: boolean; budgetThresholds: UsageBudgetThresholds } {
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [cliToolBreakdownEnabled, setCliToolBreakdownEnabled] = useState(false);
  const [budgetThresholds, setBudgetThresholds] = useState<UsageBudgetThresholds>({ dailyUsd: null, weeklyUsd: null });

  // Read toggle setting and re-read on settings changes
  useEffect(() => {
    let active = true;
    let generation = 0;
    const refresh = () => {
      const request = ++generation;
      window.electronAPI.config.get('globalUsageEnabled').then(val => {
        if (active && request === generation) setEnabled(val !== 'false');
      }).catch(() => {});
      window.electronAPI.config.get('cliToolBreakdownEnabled').then(val => {
        if (active && request === generation) setCliToolBreakdownEnabled(val === 'true');
      }).catch(() => {});
      Promise.all([
        window.electronAPI.config.get('usageBudget.dailyUsd').catch(() => null),
        window.electronAPI.config.get('usageBudget.weeklyUsd').catch(() => null),
      ]).then(([dailyUsd, weeklyUsd]) => {
        if (!active || request !== generation) return;
        setBudgetThresholds({
          dailyUsd: parseBudgetThreshold(dailyUsd),
          weeklyUsd: parseBudgetThreshold(weeklyUsd),
        });
      });
    };
    refresh();
    window.addEventListener('tether:settings-changed', refresh);
    return () => { active = false; window.removeEventListener('tether:settings-changed', refresh); };
  }, []);

  // Load + subscribe
  useEffect(() => {
    if (!enabled) {
      setUsage(null);
      return;
    }

    let active = true;
    let updated = false;
    const remove = window.electronAPI.usage.onUpdate(info => {
      updated = true;
      if (active) setUsage(info);
    });
    window.electronAPI.usage.getAll().then(info => {
      if (active && !updated) setUsage(info);
    }).catch(() => {});
    return () => { active = false; remove(); };
  }, [enabled]);

  return { usage, enabled, cliToolBreakdownEnabled, budgetThresholds };
}
