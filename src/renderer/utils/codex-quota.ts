import type { CodexQuota } from '../../shared/types';
import type { CodexResetOutcome } from '../../shared/codex-types';

export interface CodexQuotaWarning {
  key: string;
  message: string;
}

export function quotaWindowLabel(minutes: number | null | undefined, fallback = 'Window'): string {
  if (!minutes || !Number.isFinite(minutes) || minutes < 0) return fallback;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/** Warn only about fresh provider measurements with a known, future reset. */
export function codexQuotaWarnings(quota: CodexQuota | null | undefined, threshold: number, now = Date.now()): CodexQuotaWarning[] {
  if (!quota || quota.error || !Number.isFinite(threshold) || threshold <= 0 || threshold > 100) return [];
  const observedAt = Date.parse(quota.lastUpdated || '');
  if (!Number.isFinite(observedAt) || now - observedAt > 10 * 60_000 || observedAt > now + 60_000) return [];
  const warnings: CodexQuotaWarning[] = [];
  for (const bucket of quota.buckets ?? []) {
    for (const kind of ['primary', 'secondary'] as const) {
      const window = bucket[kind];
      if (!window || window.usedPercent === null || !Number.isFinite(window.usedPercent)
        || window.usedPercent < 0 || window.usedPercent > 100) continue;
      const reset = Date.parse(window.resetsAt || '');
      if (!Number.isFinite(reset) || reset <= now) continue;
      const remaining = 100 - window.usedPercent;
      if (remaining > threshold) continue;
      warnings.push({
        key: JSON.stringify([bucket.id, kind, window.resetsAt]),
        message: `${bucket.name || 'Codex'} ${quotaWindowLabel(window.windowMinutes, kind)} quota has ${Math.round(remaining)}% remaining.`,
      });
    }
  }
  return warnings;
}

/** Highest reported usage across every Codex window, or null when nothing is known. */
export function highestCodexUsedPercent(quota: CodexQuota | null | undefined): number | null {
  if (!quota) return null;
  const values = quota.buckets?.length
    ? quota.buckets.flatMap(bucket => [bucket.primary?.usedPercent, bucket.secondary?.usedPercent])
    : [quota.primary.usedPercent, quota.secondary.usedPercent];
  const known = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return known.length ? Math.max(...known) : null;
}

export interface CodexResetNotice {
  type: 'success' | 'info' | 'warning' | 'error';
  title: string;
  message: string;
}

/** User-facing notice for each reset outcome. */
export function codexResetNotice(outcome: CodexResetOutcome): CodexResetNotice {
  switch (outcome) {
    case 'reset':
      return { type: 'success', title: 'Codex limits reset', message: 'One free reset was used and your Codex rate limits were restored.' };
    case 'nothingToReset':
      return { type: 'info', title: 'Nothing to reset', message: 'Codex reported no limit that can be reset right now. Your reset was not used.' };
    case 'noCredit':
      return { type: 'warning', title: 'No resets available', message: 'Codex reported no free resets on this account.' };
    case 'alreadyRedeemed':
      return { type: 'info', title: 'Reset already applied', message: 'Codex reported this reset was already applied.' };
    case 'unsupported':
      return { type: 'warning', title: 'Reset not supported', message: 'The installed Codex CLI does not support resets. Update Codex and try again. No reset was used.' };
    default:
      return { type: 'warning', title: 'Reset result unknown', message: 'Tether could not confirm whether a reset was used. Check the reset count in the sidebar before trying again.' };
  }
}
