import { useCallback, useEffect, useRef, useState } from 'react';
import type { CodexAccountSnapshot, CodexConfigurationSnapshot } from '../../shared/codex-types';
import type { SessionInfo } from '../../shared/types';

type LoadState<T> =
  | { status: 'idle'; data: null; error: null }
  | { status: 'loading'; data: T | null; error: null }
  | { status: 'ready'; data: T; error: null }
  | { status: 'error'; data: T | null; error: string };

const idleAccount: LoadState<CodexAccountSnapshot> = { status: 'idle', data: null, error: null };
const idleConfig: LoadState<CodexConfigurationSnapshot> = { status: 'idle', data: null, error: null };

function formatNumber(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : 'Unavailable';
}

function formatSeconds(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Unavailable';
  if (value < 60) return `${Math.round(value)}s`;
  const minutes = Math.floor(value / 60);
  const seconds = Math.round(value % 60);
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function formatUpdated(value: string | null | undefined): string {
  if (!value) return 'Not loaded';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toLocaleString()} (${date.toISOString()})`;
}

function formatReset(value: string | null | undefined): string {
  if (!value) return 'no reset reported';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toLocaleString()} (${date.toISOString()})`;
}

function accountStatusText(snapshot: CodexAccountSnapshot | null): string {
  if (!snapshot) return 'Not loaded';
  if (snapshot.status === 'ready') return 'Ready';
  if (snapshot.status === 'unavailable') return 'Unavailable';
  return 'Error';
}

function Sparkline({ points }: Readonly<{ points: CodexAccountSnapshot['dailyUsage'] }>) {
  const values = points.map(point => point.tokens).filter(value => Number.isFinite(value));
  const max = Math.max(1, ...values);
  const width = 240;
  const height = 54;
  const step = points.length > 1 ? width / (points.length - 1) : width;
  const polyline = points.map((point, index) => {
    const y = height - Math.round((point.tokens / max) * (height - 6)) - 3;
    return `${Math.round(index * step)},${y}`;
  }).join(' ');

  return (
    <svg className="codex-settings-sparkline" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Daily Codex account token trend">
      <polyline points={polyline || `0,${height - 3} ${width},${height - 3}`} fill="none" />
    </svg>
  );
}

function SummaryStat({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div className="codex-settings-stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function UsageWindow({ label, usedPercent, windowMinutes, resetsAt }: Readonly<{ label: string; usedPercent: number | null; windowMinutes: number | null; resetsAt: string | null }>) {
  const pct = typeof usedPercent === 'number' && Number.isFinite(usedPercent) ? Math.max(0, Math.min(100, usedPercent)) : null;
  return (
    <div className="codex-settings-window">
      <div className="codex-settings-window-head">
        <span>{label}</span>
        <strong>{pct === null ? 'Unavailable' : `${Math.round(pct)}% used`}</strong>
      </div>
      <div className="codex-settings-meter" aria-hidden="true">
        <span style={{ width: `${pct ?? 0}%` }} />
      </div>
      <p className="form-hint">
        {windowMinutes ? `${windowMinutes} minute window` : 'Window length unavailable'}; resets {formatReset(resetsAt)}.
      </p>
    </div>
  );
}

export function CodexAccountPanel({ sessions, onConfigurationLoaded }: Readonly<{ sessions: SessionInfo[]; onConfigurationLoaded?: (snapshot: CodexConfigurationSnapshot) => void }>) {
  const [account, setAccount] = useState<LoadState<CodexAccountSnapshot>>(idleAccount);
  const [configuration, setConfiguration] = useState<LoadState<CodexConfigurationSnapshot>>(idleConfig);
  const [sessionId, setSessionId] = useState('');
  const accountGeneration = useRef(0);
  const configGeneration = useRef(0);

  useEffect(() => {
    return () => {
      accountGeneration.current += 1;
      configGeneration.current += 1;
    };
  }, []);

  const loadAccount = useCallback(async () => {
    const generation = accountGeneration.current + 1;
    accountGeneration.current = generation;
    setAccount(prev => ({ status: 'loading', data: prev.data, error: null }));
    try {
      const snapshot = await window.electronAPI.codex.account();
      if (accountGeneration.current === generation) {
        setAccount({ status: 'ready', data: snapshot, error: null });
      }
    } catch (err) {
      if (accountGeneration.current === generation) {
        setAccount(prev => ({ status: 'error', data: prev.data, error: err instanceof Error ? err.message : String(err) }));
      }
    }
  }, []);

  const loadConfiguration = useCallback(async () => {
    const generation = configGeneration.current + 1;
    configGeneration.current = generation;
    setConfiguration(prev => ({ status: 'loading', data: prev.data, error: null }));
    try {
      const snapshot = await window.electronAPI.codex.configuration(sessionId || undefined);
      if (configGeneration.current === generation) {
        setConfiguration({ status: 'ready', data: snapshot, error: null });
        onConfigurationLoaded?.(snapshot);
      }
    } catch (err) {
      if (configGeneration.current === generation) {
        setConfiguration(prev => ({ status: 'error', data: prev.data, error: err instanceof Error ? err.message : String(err) }));
      }
    }
  }, [onConfigurationLoaded, sessionId]);

  const accountData = account.data;
  const configData = configuration.data;
  const codexSessions = sessions.filter(session => session.cliTool === 'codex');

  return (
    <div className="codex-settings-panel">
      <section className="codex-settings-block">
        <div className="codex-settings-block-head">
          <div>
            <h3>Account usage</h3>
            <p className="form-hint">Account-wide Codex usage from the Codex CLI. Tether local costs are separate.</p>
          </div>
          <button type="button" className="form-btn" onClick={loadAccount} disabled={account.status === 'loading'}>
            {account.status === 'loading' ? 'Loading...' : accountData ? 'Retry' : 'Load account usage'}
          </button>
        </div>
        {account.error && <p className="codex-settings-error" role="alert">{account.error}</p>}
        {accountData ? (
          <>
            <div className="codex-settings-meta">
              <span>Status: {accountStatusText(accountData)}</span>
              <span>Updated: {formatUpdated(accountData.lastUpdated)}</span>
              {accountData.authMode && <span>Auth: {accountData.authMode}</span>}
              {accountData.planType && <span>Plan: {accountData.planType}</span>}
            </div>
            <div className="codex-settings-stats">
              <SummaryStat label="Lifetime tokens" value={formatNumber(accountData.summary?.lifetimeTokens)} />
              <SummaryStat label="Peak daily tokens" value={formatNumber(accountData.summary?.peakDailyTokens)} />
              <SummaryStat label="Longest turn" value={formatSeconds(accountData.summary?.longestRunningTurnSec)} />
              <SummaryStat label="Current streak" value={formatNumber(accountData.summary?.currentStreakDays)} />
              <SummaryStat label="Longest streak" value={formatNumber(accountData.summary?.longestStreakDays)} />
            </div>
            {accountData.dailyUsage.length > 0 && <Sparkline points={accountData.dailyUsage} />}
            {accountData.rateLimits.map(limit => (
              <div className="codex-settings-limit" key={limit.id}>
                <strong>{limit.name}</strong>
                {limit.primary && <UsageWindow label="Primary" {...limit.primary} />}
                {limit.secondary && <UsageWindow label="Secondary" {...limit.secondary} />}
              </div>
            ))}
            {accountData.warnings.map(warning => (
              <p className="codex-settings-warning" key={warning}>{warning}</p>
            ))}
          </>
        ) : (
          <p className="form-hint">Nothing loads until you ask. Availability depends on the installed Codex CLI version and account mode.</p>
        )}
      </section>

      <section className="codex-settings-block">
        <div className="codex-settings-block-head">
          <div>
            <h3>Configuration inspector</h3>
            <p className="form-hint">Shows effective Codex settings and where they came from. Commands, environment values, and URLs are omitted.</p>
          </div>
          <button type="button" className="form-btn" onClick={loadConfiguration} disabled={configuration.status === 'loading'}>
            {configuration.status === 'loading' ? 'Inspecting...' : configData ? 'Retry' : 'Inspect configuration'}
          </button>
        </div>
        <label className="form-label" htmlFor="codex-config-session">
          Project context
          <select id="codex-config-session" className="form-input" value={sessionId} onChange={e => setSessionId(e.target.value)}>
            <option value="">Global Codex config</option>
            {codexSessions.map(session => (
              <option key={session.id} value={session.id}>{session.label}</option>
            ))}
          </select>
        </label>
        {configuration.error && <p className="codex-settings-error" role="alert">{configuration.error}</p>}
        {configData ? (
          <>
            <div className="codex-settings-meta">
              <span>Status: {configData.status}</span>
              <span>Updated: {formatUpdated(configData.lastUpdated)}</span>
            </div>
            {configData.error && <p className="codex-settings-error">{configData.error}</p>}
            <div className="codex-settings-table" role="table" aria-label="Codex effective configuration">
              {configData.fields.map(field => (
                <div className="codex-settings-row" role="row" key={`${field.key}:${field.source}`}>
                  <span role="cell">{field.key}</span>
                  <code role="cell">{field.value || 'Unavailable'}</code>
                  <span role="cell">{field.source || 'Unavailable'}</span>
                </div>
              ))}
            </div>
            <div className="codex-settings-lists">
              <div>
                <h4>Native profiles</h4>
                {configData.profiles.length ? configData.profiles.map(profile => <span key={profile.name}>{profile.name}</span>) : <p className="form-hint">Unavailable</p>}
              </div>
              <div>
                <h4>Integrations</h4>
                {configData.integrations.length ? configData.integrations.map(item => (
                  <span key={`${item.kind}:${item.name}`}>{item.name} ({item.kind}{item.enabled === null ? '' : item.enabled ? ', enabled' : ', disabled'})</span>
                )) : <p className="form-hint">Unavailable</p>}
              </div>
            </div>
          </>
        ) : (
          <p className="form-hint">Use this when you need to compare Tether launch flags with Codex config. Existing sessions may still be running with older settings.</p>
        )}
      </section>
    </div>
  );
}
