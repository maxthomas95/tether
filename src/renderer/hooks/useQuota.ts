import { useState, useEffect, useCallback, useRef } from 'react';
import type { QuotaInfo } from '../../shared/types';

export function useQuota(): { quota: QuotaInfo | null; refresh: () => void; enabled: boolean } {
  const [quota, setQuota] = useState<QuotaInfo | null>(null);
  const [enabled, setEnabled] = useState(true);
  const mounted = useRef(false);
  const enabledRef = useRef(true);
  const observation = useRef(0);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    let revision = 0;
    const load = async () => {
      const request = ++revision;
      try {
        const val = await window.electronAPI.config.get('quotaEnabled');
        if (!active || request !== revision) return;
        const isEnabled = val !== 'false';
        enabledRef.current = isEnabled;
        setEnabled(isEnabled);
        const version = ++observation.current;
        if (!isEnabled) { setQuota(null); return; }
        const info = await window.electronAPI.quota.get();
        if (active && request === revision && version === observation.current) setQuota(info);
      } catch { /* Keep the last available measurement. */ }
    };
    void load();
    window.addEventListener('tether:settings-changed', load);
    const remove = window.electronAPI.quota.onUpdate((info) => {
      observation.current++;
      if (active && enabledRef.current) setQuota(info);
    });
    return () => {
      active = false;
      mounted.current = false;
      observation.current++;
      remove();
      window.removeEventListener('tether:settings-changed', load);
    };
  }, []);

  const refresh = useCallback(() => {
    if (!enabledRef.current) return;
    const version = ++observation.current;
    window.electronAPI.quota.refresh().then(info => {
      if (mounted.current && enabledRef.current && version === observation.current) setQuota(info);
    }).catch(() => {});
  }, []);

  return { quota, refresh, enabled };
}
