import { useState, useEffect, useCallback } from 'react';
import type { QuotaInfo } from '../../shared/types';

export function useQuota(): { quota: QuotaInfo | null; refresh: () => void; enabled: boolean } {
  const [quota, setQuota] = useState<QuotaInfo | null>(null);
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    // Check if quota display is enabled
    window.electronAPI.config.get('quotaEnabled').then(val => {
      const isEnabled = val !== 'false';
      setEnabled(isEnabled);
      if (isEnabled) {
        window.electronAPI.quota.get().then(setQuota);
      }
    });
    const remove = window.electronAPI.quota.onUpdate((info) => {
      // If we get an update with all nulls and no error, service was disabled
      setQuota(info);
    });
    return () => remove();
  }, []);

  const refresh = useCallback(() => {
    window.electronAPI.quota.refresh().then(setQuota);
  }, []);

  return { quota, refresh, enabled };
}
