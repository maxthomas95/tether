import React from 'react';
import { useQuota } from '../../hooks/useQuota';

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
      <span className="quota-pct">{remaining}%</span>
      {resetsAt && <span className="quota-reset">{formatResetTime(resetsAt)}</span>}
    </div>
  );
}

export function QuotaFooter() {
  const { quota, refresh, enabled } = useQuota();

  if (!enabled || !quota) return null;

  const hasClaudeData = quota.fiveHour.utilization !== null || quota.sevenDay.utilization !== null;
  const hasCodexData = quota.codex != null && quota.codex.primary.usedPercent !== null;

  // Show section when we have data OR an error (so errors aren't silently swallowed)
  const showClaude = hasClaudeData || quota.error !== null;
  const showCodex = quota.codex != null && (hasCodexData || quota.codex.error !== null);

  if (!showClaude && !showCodex) return null;

  return (
    <div className="sidebar-footer" onClick={refresh} title="Click to refresh quota">
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
          <QuotaBar label="5h" used={quota.codex.primary.usedPercent} resetsAt={quota.codex.primary.resetAt} />
          <QuotaBar label="7d" used={quota.codex.secondary.usedPercent} resetsAt={quota.codex.secondary.resetAt} />
          {quota.codex.error && <div className="quota-error">{quota.codex.error}</div>}
        </div>
      )}
    </div>
  );
}
