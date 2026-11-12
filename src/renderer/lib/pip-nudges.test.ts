import { describe, expect, it } from 'vitest';
import type { QuotaInfo } from '../../shared/types';
import type { UsageBudgetStatus } from '../utils/usage-budget';
import { PIP_QUOTA_HIGH_PERCENT, PIP_VAULT_WARN_MS, pipNudgeSignature, pipNudges } from './pip-nudges';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const at = (ms: number) => new Date(NOW + ms).toISOString();
const quota = (overrides: Partial<QuotaInfo> = {}): QuotaInfo => ({
  fiveHour: { utilization: 10, resetsAt: at(3_600_000) },
  sevenDay: { utilization: 20, resetsAt: at(86_400_000) },
  scoped: [], subscriptionType: null, rateLimitTier: null, lastUpdated: null, error: null, codex: null,
  ...overrides,
});
const budget = (period: UsageBudgetStatus['period'], crossed: boolean): UsageBudgetStatus =>
  ({ period, periodKey: period === 'daily' ? '2026-11-12' : '2026-W46', cost: 12, threshold: 10, crossed });

describe('Pip operational nudges', () => {
  it('says nothing when nothing needs attention', () => {
    expect(pipNudges({ now: NOW })).toEqual([]);
    expect(pipNudges({
      now: NOW, vault: { enabled: true, loggedIn: true, expiresAt: at(PIP_VAULT_WARN_MS + 1) }, quota: quota(),
      budget: { daily: budget('daily', false), weekly: budget('weekly', false) }, updateVersion: null,
    })).toEqual([]);
  });

  it('warns about Vault expiry only inside the warning window', () => {
    const expiresAt = at(12 * 60_000);
    expect(pipNudges({ now: NOW, vault: { enabled: true, loggedIn: true, expiresAt } }))
      .toEqual([{ key: `vault:${expiresAt}`, kind: 'vaultExpiring', detail: '12 minutes' }]);
    expect(pipNudges({ now: NOW, vault: { enabled: true, loggedIn: true, expiresAt: at(20_000) } })[0].detail).toBe('1 minute');
    for (const vault of [
      { enabled: false, loggedIn: true, expiresAt }, { enabled: true, loggedIn: false, expiresAt },
      { enabled: true, loggedIn: true }, { enabled: true, loggedIn: true, expiresAt: at(-1) },
      { enabled: true, loggedIn: true, expiresAt: 'not a date' },
    ]) expect(pipNudges({ now: NOW, vault })).toEqual([]);
  });

  it('names each quota window at or above the mark, keyed by its reset', () => {
    const resets = at(3_600_000);
    const nudges = pipNudges({
      now: NOW,
      quota: quota({
        fiveHour: { utilization: PIP_QUOTA_HIGH_PERCENT, resetsAt: resets },
        sevenDay: { utilization: PIP_QUOTA_HIGH_PERCENT - 1, resetsAt: resets },
        scoped: [{ label: 'Fable', utilization: 97, resetsAt: null }, { label: 'Opus', utilization: null, resetsAt: null }],
        codex: { primary: { usedPercent: 95, resetAt: resets }, secondary: { usedPercent: null, resetAt: null }, planType: null, error: null },
      }),
    });
    expect(nudges).toEqual([
      { key: `quota:claude-5h:${resets}`, kind: 'quotaHigh', detail: 'Claude 5-hour limit' },
      { key: 'quota:claude-7d-Fable:unknown', kind: 'quotaHigh', detail: 'Fable weekly limit' },
      { key: `quota:codex-primary:${resets}`, kind: 'quotaHigh', detail: 'Codex primary limit' },
    ]);
  });

  it('reports crossed budgets per period and an available update', () => {
    expect(pipNudges({ now: NOW, budget: { daily: budget('daily', true), weekly: budget('weekly', true) }, updateVersion: '0.8.0' })).toEqual([
      { key: 'budget:daily:2026-11-12', kind: 'budgetCrossed', detail: 'daily' },
      { key: 'budget:weekly:2026-W46', kind: 'budgetCrossed', detail: 'weekly' },
      { key: 'update:0.8.0', kind: 'updateAvailable', detail: 'v0.8.0' },
    ]);
  });

  it('orders the most time-critical first and gives equal lists equal signatures', () => {
    const sources = {
      now: NOW, vault: { enabled: true, loggedIn: true, expiresAt: at(5 * 60_000) },
      quota: quota({ fiveHour: { utilization: 99, resetsAt: null } }),
      budget: { daily: budget('daily', true), weekly: budget('weekly', false) }, updateVersion: '0.8.0',
    };
    expect(pipNudges(sources).map(nudge => nudge.kind)).toEqual(['vaultExpiring', 'quotaHigh', 'budgetCrossed', 'updateAvailable']);
    expect(pipNudgeSignature(pipNudges(sources))).toBe(pipNudgeSignature(pipNudges({ ...sources })));
    expect(pipNudgeSignature(pipNudges(sources))).not.toBe(pipNudgeSignature(pipNudges({ ...sources, now: NOW + 2 * 60_000 })));
    expect(pipNudgeSignature([])).toBe('');
  });
});
