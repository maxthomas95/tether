import React, { useState, useMemo, useCallback, useRef } from 'react';
import { onKeyActivate, stopPropagationOnKey } from '../utils/a11y';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useUsage } from '../hooks/useUsage';
import { dailyRollups, weeklyRollups, monthlyRollups, windowSummary, type RollupRow, type WindowKind } from '../utils/usage-rollups';
import { CLI_TOOL_REGISTRY, type CliToolId } from '../../shared/cli-tools';
import type { DailyCliToolUsage } from '../../shared/types';

interface UsageHistoryDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

type ViewMode = 'daily' | 'weekly' | 'monthly';

const DAILY_DAYS = 30;
const WEEKLY_WEEKS = 12;
const MONTHLY_MONTHS = 12;

function formatCost(cost: number): string {
  if (cost === 0) return '$0';
  if (cost < 0.01) return '<$0.01';
  if (cost >= 1000) return `$${(cost / 1000).toFixed(1)}k`;
  if (cost >= 100) return `$${cost.toFixed(0)}`;
  return `$${cost.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n === 0) return '0';
  if (n < 1000) return n.toString();
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

function rowTokens(row: RollupRow): number {
  return row.inputTokens + row.outputTokens + row.cacheCreationTokens + row.cacheReadTokens;
}

function toolTokens(t: DailyCliToolUsage): number {
  return t.inputTokens + t.outputTokens + t.cacheCreationTokens + t.cacheReadTokens;
}

function cliToolName(id: CliToolId): string {
  return CLI_TOOL_REGISTRY[id]?.displayName ?? id;
}

interface TileProps {
  label: string;
  cost: number;
  tokens: number;
  sessions: number;
}

function Tile({ label, cost, tokens, sessions }: TileProps) {
  return (
    <div className="usage-history-tile">
      <div className="usage-history-tile-label">{label}</div>
      <div className="usage-history-tile-cost">{formatCost(cost)}</div>
      <div className="usage-history-tile-meta">
        {sessions} {sessions === 1 ? 'session' : 'sessions'} · {formatTokens(tokens)} tokens
      </div>
    </div>
  );
}

export function UsageHistoryDialog({ isOpen, onClose }: UsageHistoryDialogProps) {
  const { usage } = useUsage();
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, isOpen);
  const [view, setView] = useState<ViewMode>('daily');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleExpanded = useCallback((key: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const summaries: Record<WindowKind, { totalCost: number; totalTokens: number; sessionCount: number }> = useMemo(() => {
    const daily = usage?.daily ?? [];
    const allTimeCost = usage?.totalCost ?? 0;
    return {
      today: windowSummary(daily, 'today', allTimeCost),
      '7d': windowSummary(daily, '7d', allTimeCost),
      '30d': windowSummary(daily, '30d', allTimeCost),
      all: windowSummary(daily, 'all', allTimeCost),
    };
  }, [usage]);

  const rollups: RollupRow[] = useMemo(() => {
    const daily = usage?.daily ?? [];
    if (view === 'daily') return dailyRollups(daily, DAILY_DAYS);
    if (view === 'weekly') return weeklyRollups(daily, WEEKLY_WEEKS);
    return monthlyRollups(daily, MONTHLY_MONTHS);
  }, [usage, view]);

  if (!isOpen) return null;

  const empty = !usage || usage.daily.length === 0;

  return (
    <div className="dialog-overlay" onClick={onClose} onKeyDown={onKeyActivate(onClose)} role="button" tabIndex={-1}>
      <div ref={dialogRef} className="dialog dialog--wide" onClick={e => e.stopPropagation()} onKeyDown={stopPropagationOnKey} role="dialog" aria-modal="true" aria-label="Usage history" tabIndex={-1}>
        <div className="dialog-header">
          <span>Usage history</span>
          <button className="dialog-close" aria-label="Close dialog" onClick={onClose}>&times;</button>
        </div>
        <div className="dialog-body">
          <div className="usage-history-tiles">
            <Tile label="Today" {...{
              cost: summaries.today.totalCost,
              tokens: summaries.today.totalTokens,
              sessions: summaries.today.sessionCount,
            }} />
            <Tile label="7 days" {...{
              cost: summaries['7d'].totalCost,
              tokens: summaries['7d'].totalTokens,
              sessions: summaries['7d'].sessionCount,
            }} />
            <Tile label="30 days" {...{
              cost: summaries['30d'].totalCost,
              tokens: summaries['30d'].totalTokens,
              sessions: summaries['30d'].sessionCount,
            }} />
            <Tile label="All-time" {...{
              cost: summaries.all.totalCost,
              tokens: summaries.all.totalTokens,
              sessions: summaries.all.sessionCount,
            }} />
          </div>

          <div className="usage-history-tabs" role="tablist">
            {(['daily', 'weekly', 'monthly'] as const).map(mode => (
              <button
                key={mode}
                role="tab"
                aria-selected={view === mode}
                className={`usage-history-tab ${view === mode ? 'usage-history-tab--active' : ''}`}
                onClick={() => setView(mode)}
              >
                {mode === 'daily' ? `Daily (${DAILY_DAYS})` : mode === 'weekly' ? `Weekly (${WEEKLY_WEEKS})` : `Monthly (${MONTHLY_MONTHS})`}
              </button>
            ))}
          </div>

          <div className="usage-history-table-wrap">
            {empty ? (
              <p className="form-hint" style={{ textAlign: 'center', marginTop: 16 }}>
                No usage tracked yet. Start a Claude, Codex, or OpenCode session to populate this view.
              </p>
            ) : (
              <table className="usage-history-table">
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left' }}>Period</th>
                    <th style={{ textAlign: 'right' }}>Sessions</th>
                    <th style={{ textAlign: 'right' }}>Tokens</th>
                    <th style={{ textAlign: 'right' }}>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {rollups.map(r => {
                    const isEmpty = r.totalCost === 0 && r.sessionCount === 0;
                    const tools = r.byCliTool ?? [];
                    const expandable = !isEmpty && tools.length > 0;
                    const isOpen = expandable && expanded.has(r.key);
                    const rowClass = [
                      isEmpty ? 'usage-history-row--empty' : '',
                      expandable ? 'usage-history-row--expandable' : '',
                      isOpen ? 'usage-history-row--open' : '',
                    ].filter(Boolean).join(' ');
                    return (
                      <React.Fragment key={r.key}>
                        <tr
                          className={rowClass}
                          {...(expandable ? {
                            onClick: () => toggleExpanded(r.key),
                            onKeyDown: onKeyActivate(() => toggleExpanded(r.key)),
                            role: 'button',
                            tabIndex: 0,
                            'aria-expanded': isOpen,
                          } : {})}
                        >
                          <td>
                            {expandable && (
                              <span className="usage-history-chevron" aria-hidden="true">
                                {isOpen ? '▼' : '▶'}
                              </span>
                            )}
                            <span className="usage-history-period-label">{r.label}</span>
                          </td>
                          <td style={{ textAlign: 'right' }}>{r.sessionCount || ''}</td>
                          <td style={{ textAlign: 'right' }}>{rowTokens(r) > 0 ? formatTokens(rowTokens(r)) : ''}</td>
                          <td style={{ textAlign: 'right' }}>{r.totalCost > 0 ? formatCost(r.totalCost) : ''}</td>
                        </tr>
                        {isOpen && tools.map(t => (
                          <tr key={`${r.key}::${t.cliTool}`} className="usage-history-row--sub">
                            <td>
                              <span className="usage-history-sub-label">{cliToolName(t.cliTool)}</span>
                            </td>
                            <td style={{ textAlign: 'right' }}>{t.sessionCount || ''}</td>
                            <td style={{ textAlign: 'right' }}>{toolTokens(t) > 0 ? formatTokens(toolTokens(t)) : ''}</td>
                            <td style={{ textAlign: 'right' }}>{t.totalCost > 0 ? formatCost(t.totalCost) : ''}</td>
                          </tr>
                        ))}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
        <div className="dialog-footer">
          <p className="form-hint" style={{ flex: 1, marginTop: 0, marginBottom: 0 }}>
            API-equivalent cost — your subscription covers this usage.
          </p>
          <button className="form-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
