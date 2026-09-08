import { describe, expect, it } from 'vitest';
import type { CodexQuota } from '../../shared/types';
import { codexQuotaWarnings, quotaWindowLabel } from './codex-quota';

const now = Date.parse('2026-09-07T10:00:00Z');
function quota(): CodexQuota {
  return {
    primary: { usedPercent: 85, resetAt: null }, secondary: { usedPercent: null, resetAt: null },
    planType: 'plus', error: null, lastUpdated: new Date(now).toISOString(),
    buckets: [{ id: 'codex', name: 'Codex', primary: { usedPercent: 85, windowMinutes: 180, resetsAt: '2026-09-07T11:00:00Z' }, secondary: null }],
  };
}
describe('Codex quota warnings', () => {
  it('uses actual window lengths and keys notifications to each provider reset', () => {
    const original = quota();
    const warnings = codexQuotaWarnings(original, 20, now);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('3h quota has 15%');
    original.buckets![0].primary!.resetsAt = '2026-09-07T12:00:00Z';
    expect(codexQuotaWarnings(original, 20, now)[0].key).not.toBe(warnings[0].key);
  });
  it('does not warn from failed, stale, expired or unknown measurements', () => {
    expect(codexQuotaWarnings({ ...quota(), error: 'Unavailable' }, 20, now)).toEqual([]);
    expect(codexQuotaWarnings(quota(), 20, now + 11 * 60_000)).toEqual([]);
    const expired = quota();
    expired.buckets![0].primary!.resetsAt = new Date(now).toISOString();
    expect(codexQuotaWarnings(expired, 20, now)).toEqual([]);
    expired.buckets![0].primary!.resetsAt = null;
    expect(codexQuotaWarnings(expired, 20, now)).toEqual([]);
  });
  it('honors disabled warnings and avoids invalid percentages', () => {
    for (const threshold of [0, -1, 101, NaN]) expect(codexQuotaWarnings(quota(), threshold, now)).toEqual([]);
    const invalid = quota();
    for (const percent of [-1, 101, NaN, null]) {
      invalid.buckets![0].primary!.usedPercent = percent;
      expect(codexQuotaWarnings(invalid, 20, now)).toEqual([]);
    }
  });
  it('formats minutes, hours and days without assuming fixed subscription windows', () => {
    expect(quotaWindowLabel(15)).toBe('15m');
    expect(quotaWindowLabel(120)).toBe('2h');
    expect(quotaWindowLabel(10080)).toBe('7d');
    expect(quotaWindowLabel(null)).toBe('Window');
  });
});
