import { useState, useEffect } from 'react';
import type { UsageInfo } from '../../shared/types';

/**
 * Subscribes to global usage updates (across all tracked sessions).
 * Returns null if disabled or no data yet.
 *
 * `cliToolBreakdownEnabled` is a separate, default-off toggle gating the
 * per-CLI-tool footer breakdown (visible "today" subline + tooltip section).
 */
export function useUsage(): { usage: UsageInfo | null; enabled: boolean; cliToolBreakdownEnabled: boolean } {
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [cliToolBreakdownEnabled, setCliToolBreakdownEnabled] = useState(false);

  // Read toggle setting and re-read on settings changes
  useEffect(() => {
    const refresh = () => {
      window.electronAPI.config.get('globalUsageEnabled').then(val => {
        setEnabled(val !== 'false');
      });
      window.electronAPI.config.get('cliToolBreakdownEnabled').then(val => {
        setCliToolBreakdownEnabled(val === 'true');
      });
    };
    refresh();
    window.addEventListener('tether:settings-changed', refresh);
    return () => window.removeEventListener('tether:settings-changed', refresh);
  }, []);

  // Load + subscribe
  useEffect(() => {
    if (!enabled) {
      setUsage(null);
      return;
    }

    window.electronAPI.usage.getAll().then(setUsage);
    const remove = window.electronAPI.usage.onUpdate(setUsage);
    return () => remove();
  }, [enabled]);

  return { usage, enabled, cliToolBreakdownEnabled };
}
