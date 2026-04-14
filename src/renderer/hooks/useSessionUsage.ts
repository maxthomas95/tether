import { useState, useEffect } from 'react';
import type { SessionUsage } from '../../shared/types';

/**
 * Subscribes to per-session usage updates filtered by claudeSessionId.
 * Returns null if no session ID provided, the feature is disabled, or
 * no data exists yet.
 */
export function useSessionUsage(claudeSessionId: string | undefined): {
  usage: SessionUsage | null;
  enabled: boolean;
} {
  const [usage, setUsage] = useState<SessionUsage | null>(null);
  const [enabled, setEnabled] = useState(true);

  // Read the toggle setting on mount and re-read on settings changes
  useEffect(() => {
    const refresh = () => {
      window.electronAPI.config.get('usageStripEnabled').then(val => {
        setEnabled(val !== 'false');
      });
    };
    refresh();
    window.addEventListener('tether:settings-changed', refresh);
    return () => window.removeEventListener('tether:settings-changed', refresh);
  }, []);

  // Load initial data + subscribe to updates for this specific session
  useEffect(() => {
    if (!claudeSessionId || !enabled) {
      setUsage(null);
      return;
    }

    window.electronAPI.usage.getSession(claudeSessionId).then(setUsage);

    const remove = window.electronAPI.usage.onUpdate((info) => {
      const sessionUsage = info.sessions[claudeSessionId] ?? null;
      setUsage(sessionUsage);
    });

    return () => remove();
  }, [claudeSessionId, enabled]);

  return { usage, enabled };
}
