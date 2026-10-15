import { useState } from 'react';
import type { LocalThemeCatalog } from '../../shared/theme-types';

interface LocalThemeControlsProps {
  catalog: LocalThemeCatalog;
  onReload: () => Promise<void>;
  disabled: boolean;
}

export function LocalThemeControls({ catalog, onReload, disabled }: Readonly<LocalThemeControlsProps>) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const run = async (action: () => Promise<void>, success: string) => {
    setBusy(true);
    setMessage('');
    setError('');
    try { await action(); setMessage(success); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load local themes.'); }
    finally { setBusy(false); }
  };
  return (
    <div className="form-group local-theme-controls">
      <div className="form-label">Your themes</div>
      <p className="form-hint">Copy the example folder, edit theme.json, then reload. Local themes stay on this computer.</p>
      <div className="local-theme-actions">
        <button type="button" className="form-btn" disabled={disabled || busy} onClick={() => void run(() => window.electronAPI.themes.openFolder(), 'Themes folder opened.')}>Open themes folder</button>
        <button type="button" className="form-btn" disabled={disabled || busy} onClick={() => void run(onReload, 'Themes reloaded.')}>{busy ? 'Working…' : 'Reload themes'}</button>
      </div>
      {catalog.directory && <p className="form-hint local-theme-path">{catalog.directory}</p>}
      {message && <p className="form-hint" role="status">{message}</p>}
      {error && <p className="form-hint local-theme-error" role="alert">{error}</p>}
      {catalog.issues.length > 0 && <div role="alert"><p className="form-hint">Some local themes could not be loaded:</p><ul>{catalog.issues.map(issue => <li key={issue.file}>{issue.file}: {issue.message}</li>)}</ul></div>}
    </div>
  );
}
