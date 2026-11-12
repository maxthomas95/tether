import { useEffect, useMemo, useRef, useState } from 'react';
import type { VaultStatus } from '../../../shared/types';
import { useQuota } from '../../hooks/useQuota';
import { useUsage } from '../../hooks/useUsage';
import { pipNudgeSignature, pipNudges, type PipNudge } from '../../lib/pip-nudges';
import { computeUsageBudgetStatus } from '../../utils/usage-budget';

const NONE: readonly PipNudge[] = [];

interface PipNudgeFeedProps {
  updateVersion: string | null;
  onChange: (nudges: readonly PipNudge[]) => void;
}

/**
 * Collects what the sidebar's own indicators already show (Vault expiry, quota,
 * usage budget, an available update) for Pip to mention. Mounted only while
 * operational nudges are on and Pip is showing, so it reads nothing otherwise.
 * It renders nothing and reads only what the sidebar footers read.
 */
export function PipNudgeFeed({ updateVersion, onChange }: Readonly<PipNudgeFeedProps>) {
  const { quota } = useQuota();
  const { usage, budgetThresholds } = useUsage();
  const [vault, setVault] = useState<VaultStatus | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.vault.status()
      .then(status => { if (!cancelled) setVault(status); })
      .catch(() => { if (!cancelled) setVault(null); });
    const unsubscribe = window.electronAPI.vault.onStatusChange(setVault);
    return () => { cancelled = true; unsubscribe(); };
  }, []);

  // The Vault warning depends on the clock, not on a status event.
  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(handle);
  }, []);

  const budget = useMemo(() => usage ? computeUsageBudgetStatus(usage.daily, budgetThresholds) : null, [usage, budgetThresholds]);
  const nudges = useMemo(() => pipNudges({ vault, quota, budget, updateVersion, now }), [vault, quota, budget, updateVersion, now]);
  const signature = pipNudgeSignature(nudges);

  // The signature stands in for the list: a new array with the same nudges is not a change.
  const latest = useRef(nudges);
  latest.current = nudges;
  useEffect(() => { onChange(latest.current); }, [signature, onChange]);

  useEffect(() => () => onChange(NONE), [onChange]);

  return null;
}
