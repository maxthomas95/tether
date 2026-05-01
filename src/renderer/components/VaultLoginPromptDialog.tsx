import { useEffect, useState } from 'react';
import { useEscapeKey } from '../hooks/useEscapeKey';

interface VaultLoginPromptDialogProps {
  isOpen: boolean;
  /** Short description of the vault reference that triggered the prompt (e.g. "env var FOO"). */
  reason?: string;
  onLoginSuccess: () => void;
  onCancel: () => void;
}

export function VaultLoginPromptDialog({ isOpen, reason, onLoginSuccess, onCancel }: VaultLoginPromptDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset transient state whenever the dialog closes so a future re-open starts
  // fresh — without this, `busy` from a prior successful login leaks across
  // open cycles (the component stays mounted and only `isOpen` toggles), which
  // would make the next prompt render with the Log In button stuck on
  // "Opening browser…" and Cancel/X disabled.
  useEffect(() => {
    if (!isOpen) {
      setBusy(false);
      setError(null);
    }
  }, [isOpen]);

  const handleCancel = () => {
    if (busy) {
      // Abort the in-flight OIDC flow so the callback server is freed and the
      // pending vault.login() promise rejects.
      window.electronAPI.vault.cancelLogin?.().catch(() => { /* ignore */ });
    }
    onCancel();
  };

  useEscapeKey(handleCancel, isOpen);
  if (!isOpen) return null;

  const handleLogin = async () => {
    setBusy(true);
    setError(null);
    try {
      const status = await window.electronAPI.vault.login();
      if (!status.loggedIn) {
        setError('Login did not complete. Please try again.');
        setBusy(false);
        return;
      }
      setBusy(false);
      onLoginSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div
      className="dialog-overlay"
      role="presentation"
      onClick={(e) => { if (e.target === e.currentTarget) handleCancel(); }}
    >
      <div className="dialog">
        <div className="dialog-header">
          <span>Vault login required</span>
          <button className="dialog-close" onClick={handleCancel}>&times;</button>
        </div>
        <div className="dialog-body">
          <p className="form-hint" style={{ marginBottom: 8 }}>
            This session references Vault secrets{reason ? ` (${reason})` : ''}, but your Vault token has expired.
          </p>
          <p className="form-hint">
            Log in to Vault to continue creating the session.
          </p>
          {error && (
            <p className="form-hint" style={{ color: 'var(--status-dead)', marginTop: 8 }}>{error}</p>
          )}
        </div>
        <div className="dialog-footer">
          <button className="form-btn" onClick={handleCancel}>Cancel</button>
          <button className="form-btn form-btn--primary" onClick={handleLogin} disabled={busy}>
            {busy ? 'Opening browser…' : 'Log In'}
          </button>
        </div>
      </div>
    </div>
  );
}
