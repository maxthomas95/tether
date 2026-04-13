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

function barClass(pct: number): string {
  if (pct > 80) return 'quota-bar-fill--crit';
  if (pct > 50) return 'quota-bar-fill--warn';
  return 'quota-bar-fill--ok';
}

interface QuotaBarProps {
  label: string;
  utilization: number | null;
  resetsAt: string | null;
}

function QuotaBar({ label, utilization, resetsAt }: QuotaBarProps) {
  if (utilization === null) return null;
  const pct = Math.round(utilization);
  return (
    <div className="quota-row">
      <span className="quota-label">{label}</span>
      <div className="quota-bar-track">
        <div
          className={`quota-bar-fill ${barClass(pct)}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="quota-pct">{pct}%</span>
      {resetsAt && <span className="quota-reset">{formatResetTime(resetsAt)}</span>}
    </div>
  );
}

export function QuotaFooter() {
  const { quota, refresh, enabled } = useQuota();

  if (!enabled || !quota) return null;

  // Nothing to show — no Claude data and no Codex data
  const hasClaudeData = quota.fiveHour.utilization !== null || quota.sevenDay.utilization !== null;
  const hasCodexData = quota.codex?.primary.usedPercent !== null;
  const hasAnyData = hasClaudeData || hasCodexData;

  if (quota.error && !hasAnyData) {
    return (
      <div className="sidebar-footer" onClick={refresh} title="Click to retry">
        <div className="quota-error">{quota.error}</div>
      </div>
    );
  }

  return (
    <div className="sidebar-footer" onClick={refresh} title="Click to refresh quota">
      {/* Claude quota */}
      {hasClaudeData && (
        <div className="quota-section">
          <div className="quota-section-header">
            <span className="quota-provider">Claude</span>
            {quota.subscriptionType && (
              <span className="quota-plan">{quota.subscriptionType}</span>
            )}
          </div>
          <QuotaBar label="5h" utilization={quota.fiveHour.utilization} resetsAt={quota.fiveHour.resetsAt} />
          <QuotaBar label="7d" utilization={quota.sevenDay.utilization} resetsAt={quota.sevenDay.resetsAt} />
          {quota.error && <div className="quota-error">{quota.error}</div>}
        </div>
      )}

      {/* Codex quota */}
      {quota.codex && hasCodexData && (
        <div className="quota-section">
          <div className="quota-section-header">
            <span className="quota-provider">Codex</span>
            {quota.codex.planType && (
              <span className="quota-plan">{quota.codex.planType}</span>
            )}
          </div>
          <QuotaBar label="1°" utilization={quota.codex.primary.usedPercent} resetsAt={quota.codex.primary.resetAt} />
          <QuotaBar label="2°" utilization={quota.codex.secondary.usedPercent} resetsAt={quota.codex.secondary.resetAt} />
          {quota.codex.error && <div className="quota-error">{quota.codex.error}</div>}
        </div>
      )}
    </div>
  );
}
