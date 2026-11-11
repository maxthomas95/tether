import React, { useEffect, useRef, useState } from 'react';
import { useQuota } from '../../hooks/useQuota';
import { onKeyActivate, stopPropagationOnKey } from '../../utils/a11y';
import { codexQuotaWarnings, highestCodexUsedPercent, quotaWindowLabel } from '../../utils/codex-quota';
import type { ConfirmOptions } from '../ConfirmDialog';
import type { CodexResetOutcome } from '../../../shared/codex-types';

/** Usage below this level makes the confirm dialog warn that a reset may be wasted. */
const RESET_WORTHWHILE_PERCENT = 80;

function formatExpiryDate(iso: string): string {
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

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

interface QuotaFooterProps {
  onQuotaLow?: (message: string) => void;
  /** Enables the "Use reset" action; the redemption is always confirmed first. */
  confirm?: (options: ConfirmOptions) => Promise<{ confirmed: boolean }>;
  onCodexReset?: (outcome: CodexResetOutcome) => void;
}

export function QuotaFooter({ onQuotaLow, confirm, onCodexReset }: QuotaFooterProps = {}) {
  const { quota, refresh, enabled } = useQuota();
  const [redeeming, setRedeeming] = useState(false);
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

  const resetCredits = quota.codex?.resetCredits ?? null;

  const redeemCodexReset = async (event: React.SyntheticEvent) => {
    // The footer itself refreshes on click; keep that out of this action.
    event.stopPropagation();
    if (!confirm || redeeming || !resetCredits?.availableCount) return;
    const count = resetCredits.availableCount;
    const highest = highestCodexUsedPercent(quota.codex);
    const parts = [`Use 1 of your ${count} free Codex reset${count === 1 ? '' : 's'} now? Codex restores your rate limits right away, and this cannot be undone.`];
    if (highest !== null && highest < RESET_WORTHWHILE_PERCENT) {
      parts.push(`Your Codex limits are only ${Math.round(highest)}% used, so you may be wasting it.`);
    }
    if (resetCredits.soonestExpiresAt) parts.push(`The soonest reset expires ${formatExpiryDate(resetCredits.soonestExpiresAt)}.`);
    const { confirmed } = await confirm({ title: 'Use a Codex reset?', message: parts.join(' '), confirmLabel: 'Use reset', danger: true });
    if (!confirmed) return;
    setRedeeming(true);
    try {
      const result = await window.electronAPI.quota.redeemCodexReset();
      onCodexReset?.(result.outcome);
    } catch {
      onCodexReset?.('unknown');
    } finally {
      setRedeeming(false);
    }
  };

  const hasClaudeData = quota.fiveHour.utilization !== null || quota.sevenDay.utilization !== null
    || !!quota.scoped?.some(window => window.utilization !== null);
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
          {quota.scoped?.filter(window => window.utilization !== null).map(window => (
            <React.Fragment key={window.label}>
              <span className="quota-plan">{window.label}</span>
              <QuotaBar label="7d" used={window.utilization} resetsAt={window.resetsAt} />
            </React.Fragment>
          ))}
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
          {resetCredits && resetCredits.availableCount > 0 && (
            <div className="quota-reset-credits">
              <span
                className="quota-reset-credits-text"
                title={resetCredits.soonestExpiresAt
                  ? `Soonest expires ${new Date(resetCredits.soonestExpiresAt).toLocaleString()}`
                  : 'Free Codex rate-limit resets'}
              >
                {resetCredits.availableCount} free reset{resetCredits.availableCount === 1 ? '' : 's'}
                {resetCredits.soonestExpiresAt && ` · expires ${formatExpiryDate(resetCredits.soonestExpiresAt)}`}
              </span>
              {confirm && (
                <button
                  type="button"
                  className="quota-reset-btn"
                  disabled={redeeming}
                  onClick={redeemCodexReset}
                  onKeyDown={stopPropagationOnKey}
                >
                  {redeeming ? 'Resetting…' : 'Use reset'}
                </button>
              )}
            </div>
          )}
          {quota.codex.lastUpdated && <div className="quota-plan">
            {quota.codex.error ? 'Last known quota' : 'Updated'} {new Date(quota.codex.lastUpdated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>}
          {quota.codex.error && <div className="quota-error">{quota.codex.error}</div>}
        </div>
      )}
    </div>
  );
}
