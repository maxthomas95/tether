import { describe, expect, it } from 'vitest';
import { normalizeCodexResetAt } from './quota-service';

describe('normalizeCodexResetAt', () => {
  it('converts Unix seconds to an ISO timestamp', () => {
    const seconds = 1_764_608_400;

    expect(normalizeCodexResetAt(seconds)).toBe(new Date(seconds * 1000).toISOString());
  });

  it('keeps millisecond epoch values as milliseconds', () => {
    const millis = 1_764_608_400_000;

    expect(normalizeCodexResetAt(millis)).toBe(new Date(millis).toISOString());
  });

  it('normalizes numeric strings and ISO strings', () => {
    const seconds = '1764608400';
    const iso = '2025-12-01T13:00:00.000Z';

    expect(normalizeCodexResetAt(seconds)).toBe(new Date(1_764_608_400 * 1000).toISOString());
    expect(normalizeCodexResetAt(iso)).toBe(iso);
  });

  it('returns null for missing or invalid values', () => {
    expect(normalizeCodexResetAt(null)).toBeNull();
    expect(normalizeCodexResetAt(undefined)).toBeNull();
    expect(normalizeCodexResetAt('')).toBeNull();
    expect(normalizeCodexResetAt('not a date')).toBeNull();
  });
});
