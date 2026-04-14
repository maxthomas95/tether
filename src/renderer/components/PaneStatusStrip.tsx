import React from 'react';
import { useSessionUsage } from '../hooks/useSessionUsage';
import type { SessionUsage } from '../../shared/types';

interface Props {
  claudeSessionId: string | undefined;
}

/** Shorten "claude-opus-4-6" → "opus-4-6". */
function shortenModel(model: string): string {
  return model.startsWith('claude-') ? model.slice('claude-'.length) : model;
}

/** Pick the model with the highest cost as the "dominant" one. */
function dominantModel(usage: SessionUsage): string | null {
  if (usage.models.length === 0) return null;
  if (usage.models.length === 1) return usage.models[0].model;
  let best = usage.models[0];
  for (const m of usage.models) {
    if (m.cost > best.cost) best = m;
  }
  return best.model;
}

function formatCost(cost: number): string {
  if (cost === 0) return '$0.00';
  if (cost < 0.01) return '<$0.01';
  if (cost >= 1000) return `$${(cost / 1000).toFixed(1)}k`;
  return `$${cost.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n === 0) return '0';
  if (n < 1000) return n.toString();
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function buildTooltip(usage: SessionUsage): string {
  const lines: string[] = [];
  lines.push(`Total cost: ${formatCost(usage.totalCost)} (API equivalent)`);
  lines.push(`Messages: ${usage.messageCount}`);
  lines.push('');
  lines.push('Tokens:');
  lines.push(`  Input:          ${formatTokens(usage.inputTokens)}`);
  lines.push(`  Output:         ${formatTokens(usage.outputTokens)}`);
  lines.push(`  Cache created:  ${formatTokens(usage.cacheCreationTokens)}`);
  lines.push(`  Cache read:     ${formatTokens(usage.cacheReadTokens)}`);

  if (usage.models.length > 1) {
    lines.push('');
    lines.push('Per-model cost:');
    for (const m of usage.models) {
      lines.push(`  ${shortenModel(m.model)}: ${formatCost(m.cost)}`);
    }
  }

  if (usage.lastMessageAt) {
    lines.push('');
    lines.push(`Last message: ${new Date(usage.lastMessageAt).toLocaleString()}`);
  }

  return lines.join('\n');
}

export function PaneStatusStrip({ claudeSessionId }: Props) {
  const { usage, enabled } = useSessionUsage(claudeSessionId);

  if (!enabled) return null;
  if (!claudeSessionId) return null;

  const model = usage ? dominantModel(usage) : null;
  const messageCount = usage?.messageCount ?? 0;
  const cost = usage?.totalCost ?? 0;
  const tooltip = usage ? buildTooltip(usage) : 'No usage data yet';

  return (
    <div className="pane-status-strip" title={tooltip}>
      <span className="pane-status-strip-item pane-status-strip-model">
        {model ? shortenModel(model) : '—'}
      </span>
      <span className="pane-status-strip-separator">·</span>
      <span className="pane-status-strip-item">
        {messageCount} {messageCount === 1 ? 'msg' : 'msgs'}
      </span>
      <span className="pane-status-strip-separator">·</span>
      <span className="pane-status-strip-item pane-status-strip-cost">
        {formatCost(cost)}
      </span>
    </div>
  );
}
