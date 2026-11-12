import type { QuotaInfo, VaultStatus } from '../../shared/types';
import type { UsageBudgetStatus } from '../utils/usage-budget';
import type { PipEventKind } from './pip-lines';

export type PipNudgeKind = Extract<PipEventKind, 'vaultExpiring' | 'quotaHigh' | 'budgetCrossed' | 'updateAvailable'>;

/**
 * Something the sidebar already shows that Pip may mention once. `key` names
 * the occurrence, so the same expiry, quota window, budget period or release is
 * never mentioned twice. `detail` fills the line.
 */
export interface PipNudge { key: string; kind: PipNudgeKind; detail: string; }

export interface PipNudgeSources {
  vault?: VaultStatus | null;
  quota?: QuotaInfo | null;
  budget?: { daily: UsageBudgetStatus; weekly: UsageBudgetStatus } | null;
  /** Version of an available update, without the leading "v". */
  updateVersion?: string | null;
  now: number;
}

/** Same window in which the Vault pill turns amber. */
export const PIP_VAULT_WARN_MS = 30 * 60_000;
export const PIP_QUOTA_HIGH_PERCENT = 90;

function vaultNudge(vault: VaultStatus | null | undefined, now: number): PipNudge[] {
  if (!vault?.enabled || !vault.loggedIn || !vault.expiresAt) return [];
  const remaining = Date.parse(vault.expiresAt) - now;
  if (!Number.isFinite(remaining) || remaining <= 0 || remaining > PIP_VAULT_WARN_MS) return [];
  const minutes = Math.max(1, Math.round(remaining / 60_000));
  return [{ key: `vault:${vault.expiresAt}`, kind: 'vaultExpiring', detail: `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}` }];
}

function quotaNudges(quota: QuotaInfo | null | undefined): PipNudge[] {
  if (!quota) return [];
  const windows: Array<{ id: string; detail: string; used: number | null; resets: string | null }> = [
    { id: 'claude-5h', detail: 'Claude 5-hour limit', used: quota.fiveHour.utilization, resets: quota.fiveHour.resetsAt },
    { id: 'claude-7d', detail: 'Claude weekly limit', used: quota.sevenDay.utilization, resets: quota.sevenDay.resetsAt },
    ...(quota.scoped ?? []).map(window => ({
      id: `claude-7d-${window.label}`, detail: `${window.label} weekly limit`, used: window.utilization, resets: window.resetsAt,
    })),
  ];
  if (quota.codex) {
    windows.push(
      { id: 'codex-primary', detail: 'Codex primary limit', used: quota.codex.primary.usedPercent, resets: quota.codex.primary.resetAt },
      { id: 'codex-secondary', detail: 'Codex secondary limit', used: quota.codex.secondary.usedPercent, resets: quota.codex.secondary.resetAt },
    );
  }
  return windows
    .filter(window => window.used !== null && window.used >= PIP_QUOTA_HIGH_PERCENT)
    .map(window => ({ key: `quota:${window.id}:${window.resets ?? 'unknown'}`, kind: 'quotaHigh' as const, detail: window.detail }));
}

function budgetNudges(budget: PipNudgeSources['budget']): PipNudge[] {
  if (!budget) return [];
  return [budget.daily, budget.weekly]
    .filter(status => status.crossed)
    .map(status => ({ key: `budget:${status.period}:${status.periodKey}`, kind: 'budgetCrossed' as const, detail: status.period }));
}

/** Pure: the nudges that are true right now, most time-critical first. */
export function pipNudges(sources: PipNudgeSources): PipNudge[] {
  const update: PipNudge[] = sources.updateVersion
    ? [{ key: `update:${sources.updateVersion}`, kind: 'updateAvailable', detail: `v${sources.updateVersion}` }]
    : [];
  return [...vaultNudge(sources.vault, sources.now), ...quotaNudges(sources.quota), ...budgetNudges(sources.budget), ...update];
}

/** Stable identity for a list, so an unchanged list does not re-render its consumer. */
export function pipNudgeSignature(nudges: readonly PipNudge[]): string {
  return nudges.map(nudge => `${nudge.key}=${nudge.detail}`).join('|');
}
