import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onKeyActivate, stopPropagationOnKey } from '../utils/a11y';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { formatCost, formatTokens } from '../utils/usage-format';
import {
  buildUsageExplorer,
  cacheReadRatio,
  createDefaultUsageExplorerFilters,
  type UsageDatePreset,
  type UsageExplorerFilters,
  type UsageExplorerSessionRow,
  type UsageSortDirection,
  type UsageSortKey,
} from '../utils/usage-explorer';
import { CLI_TOOL_REGISTRY, type CliToolId } from '../../shared/cli-tools';
import type { EnvironmentInfo, SessionInfo, UsageInfo } from '../../shared/types';
import '../styles/usage-explorer.css';

interface UsageHistoryDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

const DATE_PRESETS: Array<{ value: UsageDatePreset; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Custom' },
];

function cliToolName(id: CliToolId): string {
  return CLI_TOOL_REGISTRY[id]?.displayName ?? id;
}

function formatMessageCount(messages: number | null): string {
  return messages == null ? 'n/a' : messages.toString();
}

function percentDelta(current: number, previous: number): string {
  if (previous === 0) return current === 0 ? '0%' : 'new';
  const delta = ((current - previous) / previous) * 100;
  return `${delta > 0 ? '+' : ''}${delta.toFixed(0)}%`;
}

function toggleValue<T extends string>(values: T[], value: T): T[] {
  return values.includes(value) ? values.filter(item => item !== value) : [...values, value];
}

function cacheHitLabel(input: number, read: number, created: number): string {
  const ratio = cacheReadRatio(input, read, created);
  return ratio == null ? 'n/a' : `${Math.round(ratio * 100)}%`;
}

interface SummaryTileProps {
  label: string;
  value: string;
  meta: string;
}

function SummaryTile({ label, value, meta }: SummaryTileProps) {
  return (
    <div className="usage-explorer-tile">
      <div className="usage-explorer-tile__label">{label}</div>
      <div className="usage-explorer-tile__value">{value}</div>
      <div className="usage-explorer-tile__meta">{meta}</div>
    </div>
  );
}

interface FilterGroupProps {
  label: string;
  options: Array<{ value: string; label: string }>;
  selected: string[];
  onToggle: (value: string) => void;
}

function FilterGroup({ label, options, selected, onToggle }: FilterGroupProps) {
  if (options.length === 0) return null;
  return (
    <fieldset className="usage-explorer-filter">
      <legend>{label}</legend>
      <div className="usage-explorer-filter__choices">
        {options.map(option => (
          <label key={option.value} className="usage-explorer-check">
            <input
              type="checkbox"
              checked={selected.includes(option.value)}
              onChange={() => onToggle(option.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

interface SessionRowProps {
  row: UsageExplorerSessionRow;
  expanded: boolean;
  onToggle: () => void;
}

function SessionRow({ row, expanded, onToggle }: SessionRowProps) {
  const contextLabel = row.contextUsedTokens != null && row.contextWindowTokens != null
    ? `${formatTokens(row.contextUsedTokens)} / ${formatTokens(row.contextWindowTokens)}`
    : 'n/a';
  const contextTitle = row.currentModel || row.currentReasoningEffort
    ? `Latest observation${row.currentModel ? `: ${row.currentModel}` : ''}${row.currentReasoningEffort ? `, ${row.currentReasoningEffort}` : ''}`
    : 'Latest observation';
  return (
    <React.Fragment>
      <tr
        className="usage-explorer-ledger__row usage-explorer-ledger__row--expandable"
        onClick={onToggle}
        onKeyDown={onKeyActivate(onToggle)}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
      >
        <td>
          <span className="usage-explorer-chevron" aria-hidden="true">{expanded ? 'v' : '>'}</span>
          <span>{row.label}</span>
          {row.approximate && <span className="usage-explorer-badge">approx</span>}
        </td>
        <td>{cliToolName(row.cliTool)}</td>
        <td>{row.environmentLabel}</td>
        <td>{row.project}</td>
        <td>{row.lastDate ?? 'Unknown'}</td>
        <td className="usage-explorer-number">{formatTokens(row.tokens)}</td>
        <td className="usage-explorer-number">{formatCost(row.cost)}</td>
      </tr>
      {expanded && (
        <tr className="usage-explorer-ledger__detail">
          <td colSpan={7}>
            <div className="usage-explorer-detail-grid">
              <div>
                <span>Messages</span>
                <strong>{formatMessageCount(row.messages)}</strong>
              </div>
              <div>
                <span>Input</span>
                <strong>{formatTokens(row.inputTokens)}</strong>
              </div>
              <div>
                <span>Output</span>
                <strong>{formatTokens(row.outputTokens)}</strong>
              </div>
              <div>
                <span>Reasoning</span>
                <strong>{formatTokens(row.reasoningTokens)}</strong>
              </div>
              <div>
                <span>Cache hit</span>
                <strong>{cacheHitLabel(row.inputTokens, row.cacheReadTokens, row.cacheCreationTokens)}</strong>
              </div>
              <div>
                <span>Last request / capacity</span>
                <strong title={contextTitle}>{contextLabel}</strong>
              </div>
            </div>
            <table className="usage-explorer-model-table" aria-label="Model breakdown">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Input</th>
                  <th>Output</th>
                  <th>Cache create</th>
                  <th>Cache read</th>
                  <th>Reasoning</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {row.models.map(model => (
                  <tr key={model.model}>
                    <td>{model.model}</td>
                    <td>{formatTokens(model.inputTokens)}</td>
                    <td>{formatTokens(model.outputTokens)}</td>
                    <td>{formatTokens(model.cacheCreationTokens)}</td>
                    <td>{formatTokens(model.cacheReadTokens)}</td>
                    <td>{formatTokens(model.reasoningTokens)} subset of output</td>
                    <td>{formatCost(model.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </React.Fragment>
  );
}

export function UsageHistoryDialog({ isOpen, onClose }: UsageHistoryDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const loadGeneration = useRef(0);
  useFocusTrap(dialogRef, isOpen);
  const [filters, setFilters] = useState<UsageExplorerFilters>(() => createDefaultUsageExplorerFilters());
  const [sortKey, setSortKey] = useState<UsageSortKey>('lastActivity');
  const [sortDirection, setSortDirection] = useState<UsageSortDirection>('desc');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dialogUsage, setDialogUsage] = useState<UsageInfo | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [environments, setEnvironments] = useState<EnvironmentInfo[]>([]);

  useEffect(() => {
    const generation = ++loadGeneration.current;
    if (!isOpen) {
      setDialogUsage(null);
      setSessions([]);
      setEnvironments([]);
      return;
    }
    let active = true;
    const applyIfCurrent = <T,>(setter: (value: T) => void) => (value: T) => {
      if (active && loadGeneration.current === generation) setter(value);
    };
    window.electronAPI.environment.list().then(applyIfCurrent(setEnvironments)).catch(() => applyIfCurrent(setEnvironments)([]));
    window.electronAPI.session.list().then(applyIfCurrent(setSessions)).catch(() => applyIfCurrent(setSessions)([]));
    window.electronAPI.usage.getAll().then(applyIfCurrent(setDialogUsage)).catch(() => null);
    const removeUsageUpdate = window.electronAPI.usage.onUpdate(applyIfCurrent(setDialogUsage));
    return () => {
      active = false;
      removeUsageUpdate();
    };
  }, [isOpen]);

  const explorer = useMemo(() => buildUsageExplorer({
    usage: dialogUsage,
    sessions,
    environments,
    filters,
    sort: { key: sortKey, direction: sortDirection },
  }), [dialogUsage, sessions, environments, filters, sortKey, sortDirection]);

  const toggleExpanded = useCallback((key: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const setDatePreset = useCallback((datePreset: UsageDatePreset) => {
    setFilters(prev => ({ ...prev, datePreset }));
  }, []);

  const setFilterList = useCallback(<T extends string,>(key: keyof Pick<UsageExplorerFilters, 'cliTools' | 'projects' | 'environments' | 'models'>, value: T) => {
    setFilters(prev => ({ ...prev, [key]: toggleValue(prev[key] as T[], value) }));
  }, []);

  const selectDay = useCallback((date: string) => {
    if (date === 'unknown') return;
    setFilters(prev => ({ ...prev, datePreset: 'custom', customStartDate: date, customEndDate: date }));
  }, []);

  const chooseSort = useCallback((key: UsageSortKey) => {
    if (sortKey === key) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
      return;
    }
    setSortKey(key);
    setSortDirection(key === 'session' ? 'asc' : 'desc');
  }, [sortKey]);

  if (!isOpen) return null;

  const maxDailyCost = Math.max(0, ...explorer.daily.map(day => day.cost));
  const empty = !dialogUsage || explorer.sessions.length === 0;

  return (
    <div className="dialog-overlay" onClick={onClose} onKeyDown={onKeyActivate(onClose)} role="button" tabIndex={-1}>
      <div ref={dialogRef} className="dialog dialog--wide usage-explorer-dialog" onClick={e => e.stopPropagation()} onKeyDown={stopPropagationOnKey} role="dialog" aria-modal="true" aria-label="Usage history" tabIndex={-1}>
        <div className="dialog-header">
          <span>Usage history</span>
          <button className="dialog-close" aria-label="Close dialog" onClick={onClose}>&times;</button>
        </div>
        <div className="dialog-body usage-explorer">
          <div className="usage-explorer-presets" aria-label="Date range">
            {DATE_PRESETS.map(preset => (
              <button
                key={preset.value}
                className={`usage-explorer-preset ${filters.datePreset === preset.value ? 'usage-explorer-preset--active' : ''}`}
                onClick={() => setDatePreset(preset.value)}
                aria-pressed={filters.datePreset === preset.value}
              >
                {preset.label}
              </button>
            ))}
            {filters.datePreset === 'custom' && (
              <div className="usage-explorer-custom-range">
                <input
                  type="date"
                  value={filters.customStartDate}
                  onChange={event => setFilters(prev => ({ ...prev, customStartDate: event.target.value }))}
                  aria-label="Custom start date"
                />
                <input
                  type="date"
                  value={filters.customEndDate}
                  onChange={event => setFilters(prev => ({ ...prev, customEndDate: event.target.value }))}
                  aria-label="Custom end date"
                />
              </div>
            )}
          </div>

          <div className="usage-explorer-filters">
            <FilterGroup label="CLI" options={explorer.options.cliTools.map(option => ({ ...option, label: cliToolName(option.value) }))} selected={filters.cliTools} onToggle={value => setFilterList('cliTools', value as CliToolId)} />
            <FilterGroup label="Project" options={explorer.options.projects} selected={filters.projects} onToggle={value => setFilterList('projects', value)} />
            <FilterGroup label="Environment" options={explorer.options.environments} selected={filters.environments} onToggle={value => setFilterList('environments', value)} />
            <FilterGroup label="Model" options={explorer.options.models} selected={filters.models} onToggle={value => setFilterList('models', value)} />
          </div>

          <div className="usage-explorer-tiles">
            <SummaryTile label={explorer.dateRange.label} value={formatCost(explorer.totals.cost)} meta={`${explorer.totals.sessions} sessions, ${formatTokens(explorer.totals.tokens)} tokens`} />
            <SummaryTile label={explorer.comparison.label} value={explorer.comparison.available ? formatCost(explorer.comparison.totals.cost) : 'n/a'} meta={explorer.comparison.available ? `${percentDelta(explorer.totals.cost, explorer.comparison.totals.cost)} vs prior` : 'No finite comparison'} />
            <SummaryTile label="Messages" value={formatMessageCount(explorer.totals.messages)} meta={`${formatTokens(explorer.totals.inputTokens)} in, ${formatTokens(explorer.totals.outputTokens)} out`} />
            <SummaryTile label="Cache" value={cacheHitLabel(explorer.totals.inputTokens, explorer.totals.cacheReadTokens, explorer.totals.cacheCreationTokens)} meta={`${formatTokens(explorer.totals.cacheReadTokens)} read`} />
          </div>

          {explorer.dateRange.invalid && (
            <p className="form-hint usage-explorer-range-message">
              Enter valid custom dates as YYYY-MM-DD.
            </p>
          )}
          {explorer.dateRange.capped && (
            <p className="form-hint usage-explorer-range-message">
              Custom trend capped to 366 UTC days from the start date.
            </p>
          )}
          {explorer.includesUnknownDay && (
            <p className="form-hint usage-explorer-range-message">
              Usage with unknown dates is included in totals and omitted from the trend.
            </p>
          )}

          <div className="usage-explorer-chart" aria-label="Daily usage trend">
            {explorer.daily.map(day => (
              <button
                key={day.date}
                className={`usage-explorer-chart__bar ${day.approximate ? 'usage-explorer-chart__bar--approx' : ''}`}
                style={{ '--bar-height': `${maxDailyCost > 0 ? Math.max(8, (day.cost / maxDailyCost) * 100) : 0}%` } as React.CSSProperties}
                onClick={() => selectDay(day.date)}
                title={`${day.label}: ${formatCost(day.cost)}`}
                aria-label={`${day.label}: ${formatCost(day.cost)}`}
              >
                <span />
                <small>{day.label}</small>
              </button>
            ))}
          </div>

          <div className="usage-explorer-ledger-toolbar">
            <span>{explorer.sessions.length} matching {explorer.sessions.length === 1 ? 'session' : 'sessions'}</span>
            <button className="form-btn" onClick={() => setFilters(createDefaultUsageExplorerFilters())}>Reset filters</button>
          </div>

          <div className="usage-explorer-table-wrap">
            {empty ? (
              <p className="form-hint usage-explorer-empty">
                No usage matches these filters. Start a Claude, Codex, or OpenCode session to populate this view.
              </p>
            ) : (
              <table className="usage-explorer-ledger">
                <thead>
                  <tr>
                    <th><button onClick={() => chooseSort('session')}>Session</button></th>
                    <th>CLI</th>
                    <th>Environment</th>
                    <th>Project</th>
                    <th><button onClick={() => chooseSort('lastActivity')}>Last</button></th>
                    <th><button onClick={() => chooseSort('tokens')}>Tokens</button></th>
                    <th><button onClick={() => chooseSort('cost')}>Cost</button></th>
                  </tr>
                </thead>
                <tbody>
                  {explorer.sessions.map(row => (
                    <SessionRow
                      key={row.sessionId}
                      row={row}
                      expanded={expanded.has(row.sessionId)}
                      onToggle={() => toggleExpanded(row.sessionId)}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
        <div className="dialog-footer">
          <p className="form-hint usage-explorer-footer">
            API-equivalent local estimates. Reasoning tokens are shown separately and are already included in output totals.
          </p>
          <button className="form-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
