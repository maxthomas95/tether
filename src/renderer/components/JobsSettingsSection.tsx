import { useEffect, useRef, useState } from 'react';
import type { JobsSettings, JobsStatus } from '../../shared/types';
import { HelpAnchor } from './HelpAnchor';

interface Props {
  settings: JobsSettings | null;
  status: JobsStatus | null;
  busy: boolean;
  dirty: boolean;
  error: string;
  onChange: (settings: JobsSettings) => void;
  onApply: () => void;
  onDisable: () => void;
  onRemove: () => void;
}

function statusLabel(status: JobsStatus | null): string {
  if (!status) return 'Loading connection status…';
  if (status.enabled === 'off') return 'Off — no connection or session sharing';
  if (status.phase === 'starting') return 'Starting the local JOBS server…';
  if (status.phase === 'checking') return 'Checking the connection…';
  if (status.detected) return `Connected${status.version ? ` · v${status.version}` : ''}${status.managed ? ' · Started by Tether' : ' · Running independently'}`;
  return 'Not connected';
}

export function JobsSettingsSection({ settings, status, busy, dirty, error, onChange, onApply, onDisable, onRemove }: Readonly<Props>) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const change = (patch: Partial<JobsSettings>) => { if (settings) onChange({ ...settings, ...patch }); };
  const [browseError, setBrowseError] = useState('');
  const currentSettings = useRef(settings);
  currentSettings.current = settings;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return (
    <section className="form-group" style={{ marginTop: 20 }} aria-label="J.O.B.S. Office">
      <div className="form-label" style={{ fontSize: 14, marginBottom: 8 }}>
        J.O.B.S. Office <HelpAnchor page="settings" anchor="jobs-office" />
      </div>
      <p className="form-hint">
        An optional pixel-art office for your agents. Connect to your own JOBS server,
        then choose whether to share Tether’s remote sessions.
      </p>
      <button className="form-btn" type="button" onClick={() => window.electronAPI.shell.openExternal('https://github.com/maxthomas95/JOBS')}>
        Get JOBS / setup instructions
      </button>
      <fieldset disabled={busy || !settings} style={{ border: 0, padding: 0, margin: '12px 0' }}>
        <label className="form-radio-label">
          <input type="checkbox" checked={settings?.enabled === 'auto'} onChange={e => change({ enabled: e.target.checked ? 'auto' : 'off' })} />
          Enable JOBS connection
        </label>
        {settings?.enabled === 'auto' && <>
          <div className="form-group" style={{ marginTop: 12 }}>
            <label className="form-label" htmlFor="jobs-url">Server URL</label>
            <input id="jobs-url" className="form-input" value={settings.url} onChange={e => change({ url: e.target.value })} placeholder="http://localhost:8780" spellCheck={false} />
            <p className="form-hint">Use the address of an existing office, including a server you run with Docker.</p>
          </div>
          <div className="form-group">
            <label className="form-radio-label">
              <input type="checkbox" checked={settings.shareRemoteSessions} onChange={e => change({ shareRemoteSessions: e.target.checked })} />
              Share SSH and Coder sessions with JOBS
            </label>
            <p className="form-hint">
              Sends session labels, project folder names, environment names, CLI names, and activity status.
              Prompts and terminal contents are never sent. Leave off to only view the office.
            </p>
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="jobs-token">Webhook token (optional)</label>
            <input id="jobs-token" className="form-input" type="password" value={settings.token} onChange={e => change({ token: e.target.value })} autoComplete="off" spellCheck={false} />
            <p className="form-hint">Use your server’s webhook token for sharing. Stored encrypted using your OS keychain; also used when Tether launches JOBS.</p>
          </div>
          <div className="form-group">
            <label className="form-radio-label">
              <input type="checkbox" checked={settings.autoLaunch} onChange={e => change({ autoLaunch: e.target.checked })} />
              Let Tether start JOBS automatically
            </label>
            <p className="form-hint">Starts your built local checkout if no office is running. Requires Node.js. Tether stops its own server when disabled or on quit.</p>
          </div>
          {settings.autoLaunch && <div className="form-group">
            <label className="form-label" htmlFor="jobs-path">Local JOBS folder</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input id="jobs-path" className="form-input" value={settings.path} onChange={e => change({ path: e.target.value })} placeholder="Choose your built JOBS checkout" spellCheck={false} style={{ flex: 1 }} />
              <button className="form-btn" type="button" onClick={async () => {
                try {
                  setBrowseError('');
                  const dir = await window.electronAPI.dialog.openDirectory();
                  if (dir && mounted.current && currentSettings.current === settings) change({ path: dir });
                } catch {
                  if (mounted.current) setBrowseError('Could not open the folder picker. You can enter the folder path directly.');
                }
              }}>Browse…</button>
            </div>
            <p className="form-hint">Build once in that folder: <code>npm install</code>, then <code>npm run build</code>.</p>
          </div>}
        </>}
      </fieldset>
      <p className="form-hint">JOBS may watch local transcripts independently. Manage that watcher in JOBS; these controls affect Tether’s connection and sharing.</p>
      <div role="status" aria-live="polite" className="form-hint" style={{ margin: '12px 0', color: status?.detected ? 'var(--status-running)' : 'var(--text-secondary)' }}>
        {statusLabel(status)}
        {dirty && <div>Unsaved JOBS changes — use Save or the button below to apply.</div>}
      </div>
      {(error || browseError || status?.error || status?.bridgeError) && <p role="alert" className="form-hint" style={{ color: 'var(--status-dead)' }}>
        {error || browseError || status?.error || status?.bridgeError}
      </p>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button className="form-btn form-btn--primary" type="button" disabled={busy || !settings} onClick={onApply}>
          {busy ? 'Applying…' : settings?.enabled === 'auto' ? 'Save and connect' : 'Save JOBS settings'}
        </button>
        {status?.enabled === 'auto' && <button className="form-btn" type="button" disabled={busy} onClick={onDisable}>Turn off now</button>}
        {status?.detected && <button className="form-btn" type="button" onClick={() => window.electronAPI.shell.openExternal(status.url)}>Open office</button>}
        <button className="form-btn" type="button" disabled={busy} onClick={() => setConfirmRemove(true)}>Remove integration…</button>
      </div>
      {confirmRemove && <div style={{ marginTop: 12 }}>
        <p className="form-hint">Turn off JOBS and forget the saved URL, token, folder, and sharing preferences? Your JOBS files and independently running server are kept.</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="form-btn" type="button" disabled={busy} onClick={() => { setConfirmRemove(false); onRemove(); }}>Remove and forget</button>
          <button className="form-btn" type="button" disabled={busy} onClick={() => setConfirmRemove(false)}>Keep integration</button>
        </div>
      </div>}
    </section>
  );
}
