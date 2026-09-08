import { useState, useEffect } from 'react';
import type { SessionUsage } from '../../shared/types';

/**
 * Subscribes to per-session usage updates filtered by sessionId.
 * Returns null if no session ID provided, the feature is disabled, or
 * no data exists yet.
 */
export function useSessionUsage(sessionId: string | undefined): {
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
    if (!sessionId || !enabled) {
      setUsage(null);
      return;
    }

    let disposed = false;
    let updated = false;
    setUsage(null);
    window.electronAPI.usage.getSession(sessionId).then(value => {
      if (!disposed && !updated) setUsage(value);
    }).catch(() => { /* wait for the next usage update */ });

    const remove = window.electronAPI.usage.onUpdate((info) => {
      updated = true;
      const sessionUsage = info.sessions[sessionId] ?? null;
      setUsage(sessionUsage);
    });

    return () => { disposed = true; remove(); };
  }, [sessionId, enabled]);

  return { usage, enabled };
}
