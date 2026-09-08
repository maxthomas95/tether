import React, { useEffect, useRef, useState } from 'react';
import { useQuota } from '../../hooks/useQuota';
import { onKeyActivate } from '../../utils/a11y';
import { codexQuotaWarnings, quotaWindowLabel } from '../../utils/codex-quota';

function formatResetTime(iso: string | null): string {
  if (!iso) return '';
  const delta = new Date(iso).getTime() - Date.now();
  if (delta <= 0) return 'now';
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  if (hours < 24) return `${hours}h ${remainMin}m`;
  const days = Math.floor(hours / 24);
  const remainHrs = hours % 24;
  return `${days}d ${remainHrs}h`;
}

/** Color class based on how much remains (high remaining = green). */
function remainingBarClass(remaining: number): string {
  if (remaining < 20) return 'quota-bar-fill--crit';
  if (remaining < 50) return 'quota-bar-fill--warn';
  return 'quota-bar-fill--ok';
}

interface QuotaBarProps {
  label: string;
  used: number | null;
  resetsAt: string | null;
}

function QuotaBar({ label, used, resetsAt }: QuotaBarProps) {
  if (used === null) return null;
  const remaining = Math.max(0, Math.round(100 - used));
  return (
    <div className="quota-row" title={`${Math.round(used)}% used · ${remaining}% left${resetsAt ? ` · resets in ${formatResetTime(resetsAt)}` : ''}`}>
      <span className="quota-label">{label}</span>
      <div className="quota-bar-track">
        <div
          className={`quota-bar-fill ${remainingBarClass(remaining)}`}
          style={{ width: `${remaining}%` }}
        />
      </div>
      <span className="quota-pct">{remaining}% left</span>
      {resetsAt && <span className="quota-reset">{formatResetTime(resetsAt)}</span>}
    </div>
  );
}

export function QuotaFooter({ onQuotaLow }: { onQuotaLow?: (message: string) => void } = {}) {
  const { quota, refresh, enabled } = useQuota();
  const [warningThreshold, setWarningThreshold] = useState(0);
  const warned = useRef(new Set<string>());

  useEffect(() => {
    let active = true;
    const readThreshold = () => {
      window.electronAPI.config.get('codexQuotaWarningPercent').then(value => {
        if (active) setWarningThreshold(Number(value) || 0);
      }).catch(() => {});
    };
    readThreshold();
    window.addEventListener('tether:settings-changed', readThreshold);
    return () => { active = false; window.removeEventListener('tether:settings-changed', readThreshold); };
  }, []);

  useEffect(() => {
    if (!enabled || !onQuotaLow) return;
    const due = codexQuotaWarnings(quota?.codex, warningThreshold).filter(row => !warned.current.has(row.key));
    if (!due.length) return;
    let active = true;
    window.electronAPI.config.get('codexQuotaLastWarnings').then(async raw => {
      if (!active) return;
      let previous: string[] = [];
      try {
        const parsed: unknown = JSON.parse(raw || '[]');
        if (Array.isArray(parsed)) previous = parsed.filter((key): key is string => typeof key === 'string').slice(-64);
      } catch { /* An invalid marker must not prevent future warnings. */ }
      const keys = new Set(previous);
      for (const warning of due) {
        if (keys.has(warning.key) || warned.current.has(warning.key)) continue;
        warned.current.add(warning.key);
        keys.add(warning.key);
        onQuotaLow(warning.message);
      }
      await window.electronAPI.config.set('codexQuotaLastWarnings', JSON.stringify([...keys].slice(-64)));
    }).catch(() => {});
    return () => { active = false; };
  }, [enabled, quota?.codex, warningThreshold, onQuotaLow]);

  if (!enabled || !quota) return null;

  const hasClaudeData = quota.fiveHour.utilization !== null || quota.sevenDay.utilization !== null;
  const hasCodexData = quota.codex != null && (quota.codex.primary.usedPercent !== null
    || quota.codex.secondary.usedPercent !== null
    || !!quota.codex.buckets?.some(bucket => bucket.primary?.usedPercent != null || bucket.secondary?.usedPercent != null));

  // Show section when we have data OR an error (so errors aren't silently swallowed)
  const showClaude = hasClaudeData || quota.error !== null;
  const showCodex = quota.codex != null && (hasCodexData || quota.codex.error !== null);

  if (!showClaude && !showCodex) return null;

  return (
    <div className="sidebar-footer" onClick={refresh} onKeyDown={onKeyActivate(refresh)} role="button" tabIndex={0} title="Click to refresh quota">
      {/* Claude quota */}
      {showClaude && (
        <div className="quota-section">
          <div className="quota-section-header">
            <span className="quota-provider">Claude</span>
            {quota.subscriptionType && (
              <span className="quota-plan">{quota.subscriptionType}</span>
            )}
          </div>
          <QuotaBar label="5h" used={quota.fiveHour.utilization} resetsAt={quota.fiveHour.resetsAt} />
          <QuotaBar label="7d" used={quota.sevenDay.utilization} resetsAt={quota.sevenDay.resetsAt} />
          {quota.error && <div className="quota-error">{quota.error}</div>}
        </div>
      )}

      {/* Codex quota */}
      {showCodex && quota.codex && (
        <div className="quota-section">
          <div className="quota-section-header">
            <span className="quota-provider">Codex</span>
            {quota.codex.planType && (
              <span className="quota-plan">{quota.codex.planType}</span>
            )}
          </div>
          {quota.codex.buckets?.length ? quota.codex.buckets.map(bucket => (
            <React.Fragment key={bucket.id}>
              {quota.codex!.buckets!.length > 1 && <span className="quota-plan">{bucket.name}</span>}
              {bucket.primary && <QuotaBar label={quotaWindowLabel(bucket.primary.windowMinutes, 'Primary')} used={bucket.primary.usedPercent} resetsAt={bucket.primary.resetsAt} />}
              {bucket.secondary && <QuotaBar label={quotaWindowLabel(bucket.secondary.windowMinutes, 'Secondary')} used={bucket.secondary.usedPercent} resetsAt={bucket.secondary.resetsAt} />}
            </React.Fragment>
          )) : <>
            <QuotaBar label="Primary" used={quota.codex.primary.usedPercent} resetsAt={quota.codex.primary.resetAt} />
            <QuotaBar label="Secondary" used={quota.codex.secondary.usedPercent} resetsAt={quota.codex.secondary.resetAt} />
          </>}
          {quota.codex.lastUpdated && <div className="quota-plan">
            {quota.codex.error ? 'Last known quota' : 'Updated'} {new Date(quota.codex.lastUpdated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>}
          {quota.codex.error && <div className="quota-error">{quota.codex.error}</div>}
        </div>
      )}
    </div>
  );
}
