import type { VaultStatus } from '../../shared/types';

interface VaultLoginControlsProps {
  status: VaultStatus;
  /** False until the address and role needed for OIDC login are filled in. */
  canLogIn: boolean;
  loggingIn: boolean;
  error: string | null;
  onLogin: () => void;
  onLogout: () => void;
  onCancelLogin: () => void;
  onMigrate: () => void;
}

export function formatExpiry(expiresAt?: string): string {
  if (!expiresAt) return '';
  const ms = Date.parse(expiresAt) - Date.now();
  if (!Number.isFinite(ms)) return expiresAt;
  if (ms <= 0) return 'expired';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

function loggedInSummary(status: VaultStatus): string {
  const identity = status.identity ? ` as ${status.identity}` : '';
  const expiry = status.expiresAt ? `, expires ${formatExpiry(status.expiresAt)}` : '';
  return `● Logged in${identity}${expiry}`;
}

/** Vault login state and the actions that depend on it, shown in Settings. */
export function VaultLoginControls({ status, canLogIn, loggingIn, error, onLogin, onLogout, onCancelLogin, onMigrate }: Readonly<VaultLoginControlsProps>) {
  return (
    <div className="form-group">
      <div className="form-label">Status</div>
      <div style={{ marginTop: 4 }}>
        {status.loggedIn ? (
          <span className="form-hint" style={{ color: 'var(--status-running)' }}>{loggedInSummary(status)}</span>
        ) : (
          <span className="form-hint" style={{ color: 'var(--text-muted)' }}>{'○'} Not logged in</span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        {status.loggedIn ? (
          <button className="form-btn" onClick={onLogout}>Log Out</button>
        ) : (
          <button className="form-btn form-btn--primary" onClick={onLogin} disabled={loggingIn || !canLogIn}>
            {loggingIn ? 'Opening browser…' : 'Log In'}
          </button>
        )}
        {loggingIn && <button className="form-btn" onClick={onCancelLogin}>Cancel login</button>}
        <button className="form-btn" onClick={onMigrate} disabled={!status.loggedIn}>
          Migrate Existing Secrets…
        </button>
      </div>
      {error && (
        <p className="form-hint" style={{ color: 'var(--status-dead)', marginTop: 6 }}>{error}</p>
      )}
    </div>
  );
}
