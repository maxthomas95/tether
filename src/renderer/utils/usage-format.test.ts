import { describe, it, expect } from 'vitest';
import { formatCost, formatTokens } from './usage-format';

describe('formatCost', () => {
  it('formats the tiers', () => {
    expect(formatCost(0)).toBe('$0');
    expect(formatCost(0.005)).toBe('<$0.01');
    expect(formatCost(0.5)).toBe('$0.50');
    expect(formatCost(150)).toBe('$150');
    expect(formatCost(2500)).toBe('$2.5k');
  });
});

describe('formatTokens', () => {
  it('formats the tiers', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1500)).toBe('1.5k');
    expect(formatTokens(2_500_000)).toBe('2.50M');
    expect(formatTokens(3_000_000_000)).toBe('3.00B');
  });
});
