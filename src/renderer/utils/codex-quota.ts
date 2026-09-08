import type { CodexQuota } from '../../shared/types';

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
