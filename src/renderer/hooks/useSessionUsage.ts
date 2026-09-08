import { useState, useEffect, useRef } from 'react';
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
  const settingsGenerationRef = useRef(0);
  const usageGenerationRef = useRef(0);

  // Read the toggle setting on mount and re-read on settings changes
  useEffect(() => {
    const refresh = () => {
      const generation = ++settingsGenerationRef.current;
      window.electronAPI.config.get('usageStripEnabled').then(val => {
        if (generation !== settingsGenerationRef.current) return;
        setEnabled(val !== 'false');
      }).catch(() => {});
    };
    refresh();
    window.addEventListener('tether:settings-changed', refresh);
    return () => {
      settingsGenerationRef.current++;
      window.removeEventListener('tether:settings-changed', refresh);
    };
  }, []);

  // Load initial data + subscribe to updates for this specific session
  useEffect(() => {
    const generation = ++usageGenerationRef.current;
    if (!sessionId || !enabled) {
      setUsage(null);
      return;
    }

    window.electronAPI.usage.getSession(sessionId).then(nextUsage => {
      if (generation !== usageGenerationRef.current) return;
      setUsage(nextUsage);
    }).catch(() => {
      if (generation !== usageGenerationRef.current) return;
      setUsage(null);
    });

    const remove = window.electronAPI.usage.onUpdate((info) => {
      if (generation !== usageGenerationRef.current) return;
      const sessionUsage = info.sessions[sessionId] ?? null;
      setUsage(sessionUsage);
    });

    return () => {
      usageGenerationRef.current++;
      remove();
    };
  }, [sessionId, enabled]);

  return { usage, enabled };
}
