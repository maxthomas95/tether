import { useState, useEffect, useCallback } from 'react';
import type { QuotaInfo } from '../../shared/types';

export function useQuota(): { quota: QuotaInfo | null; refresh: () => void } {
  const [quota, setQuota] = useState<QuotaInfo | null>(null);

  useEffect(() => {
    window.electronAPI.quota.get().then(setQuota);
    const remove = window.electronAPI.quota.onUpdate(setQuota);
    return () => remove();
  }, []);

  const refresh = useCallback(() => {
    window.electronAPI.quota.refresh().then(setQuota);
  }, []);

  return { quota, refresh };
}
