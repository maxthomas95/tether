import { useState, useEffect } from 'react';
import type { RepoBranchStatus } from '../../shared/types';

const REFRESH_INTERVAL_MS = 60_000;

/**
 * Fetches branch + uncommitted-change count for a local repo group header.
 * Disabled (always null, no fetching) for non-local environments — local git
 * status against an SSH/Coder path makes no sense.
 */
export function useBranchStatus(repoPath: string, enabled: boolean): RepoBranchStatus | null {
  const [status, setStatus] = useState<RepoBranchStatus | null>(null);

  useEffect(() => {
    if (!enabled) {
      setStatus(null);
      return;
    }

    let cancelled = false;
    const fetchStatus = () => {
      window.electronAPI.git.branchStatus(repoPath).then((result) => {
        if (cancelled) return;
        setStatus(result);
      });
    };

    fetchStatus();
    window.addEventListener('focus', fetchStatus);
    const interval = setInterval(fetchStatus, REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.removeEventListener('focus', fetchStatus);
      clearInterval(interval);
    };
  }, [repoPath, enabled]);

  return status;
}
