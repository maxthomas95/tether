/**
 * Shared cost/token formatting for the usage surfaces (global footer, usage
 * history dialog). PaneStatusStrip keeps its own compact variants on purpose
 * ($0.00 baseline, no B tier) — don't merge them into these.
 */
export function formatCost(cost: number): string {
  if (cost === 0) return '$0';
  if (cost < 0.01) return '<$0.01';
  if (cost >= 1000) return `$${(cost / 1000).toFixed(1)}k`;
  if (cost >= 100) return `$${cost.toFixed(0)}`;
  return `$${cost.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  if (n === 0) return '0';
  if (n < 1000) return n.toString();
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}
