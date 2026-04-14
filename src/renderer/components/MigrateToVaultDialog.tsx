import { useEffect, useState, useCallback } from 'react';
import { useEscapeKey } from '../hooks/useEscapeKey';
import type { VaultPlaintextSecret } from '../../shared/types';

interface MigrateToVaultDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

interface RowState {
  secret: VaultPlaintextSecret;
  targetRef: string;
  status: 'pending' | 'migrating' | 'done' | 'error';
  error?: string;
}

function rowKey(s: VaultPlaintextSecret): string {
  return `${s.source}::${s.sourceId || ''}::${s.key || ''}`;
}

export function MigrateToVaultDialog({ isOpen, onClose }: MigrateToVaultDialogProps) {
  const [rows, setRows] = useState<RowState[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const list = await window.electronAPI.vault.listPlaintext();
      setRows(list.map(s => ({ secret: s, targetRef: s.suggestedRef, status: 'pending' as const })));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) load();
    else setRows([]);
  }, [isOpen, load]);

  const updateRef = (key: string, ref: string) => {
    setRows(prev => prev.map(r => rowKey(r.secret) === key ? { ...r, targetRef: ref, status: 'pending', error: undefined } : r));
  };

  const migrate = async (key: string) => {
    const target = rows.find(r => rowKey(r.secret) === key);
    if (!target) return;
    setRows(prev => prev.map(r => rowKey(r.secret) === key ? { ...r, status: 'migrating', error: undefined } : r));
    try {
      await window.electronAPI.vault.migrateSecret({
        source: target.secret.source,
        sourceId: target.secret.sourceId,
        key: target.secret.key,
        targetRef: target.targetRef,
      });
      setRows(prev => prev.map(r => rowKey(r.secret) === key ? { ...r, status: 'done' } : r));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setRows(prev => prev.map(r => rowKey(r.secret) === key ? { ...r, status: 'error', error: message } : r));
    }
  };

  useEscapeKey(onClose, isOpen);
  if (!isOpen) return null;

  const pendingCount = rows.filter(r => r.status !== 'done').length;

  return (
    <div
      className="dialog-overlay"
      role="presentation"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
    >
      <div className="dialog dialog--wide">
        <div className="dialog-header">
          <span>Migrate Secrets to Vault</span>
          <button className="dialog-close" onClick={onClose}>&times;</button>
        </div>
        <div className="dialog-body" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
          <p className="form-hint" style={{ marginBottom: 12 }}>
            Each plaintext secret below will be written to the chosen Vault path,
            and its slot in your local data file will be replaced with a
            <code> vault://...</code> reference. Migration is one-way — the original
            value is not retained.
          </p>

          {loading && <p className="form-hint">Scanning for plaintext secrets…</p>}
          {loadError && (
            <p className="form-hint" style={{ color: 'var(--status-dead)' }}>
              Failed to scan: {loadError}
            </p>
          )}
          {!loading && !loadError && rows.length === 0 && (
            <p className="form-hint">No plaintext secrets found. You're all set.</p>
          )}

          {rows.map(row => {
            const key = rowKey(row.secret);
            const isDone = row.status === 'done';
            return (
              <div
                key={key}
                style={{
                  border: '1px solid var(--border-color)',
                  borderRadius: 4,
                  padding: 12,
                  marginBottom: 8,
                  opacity: isDone ? 0.6 : 1,
                }}
              >
                <div style={{ marginBottom: 6, fontWeight: 500 }}>{row.secret.displayName}</div>
                <div className="form-row">
                  <input
                    className="form-input"
                    value={row.targetRef}
                    onChange={e => updateRef(key, e.target.value)}
                    disabled={isDone || row.status === 'migrating'}
                    spellCheck={false}
                  />
                  <button
                    className="form-btn form-btn--primary"
                    onClick={() => migrate(key)}
                    disabled={isDone || row.status === 'migrating' || !row.targetRef.startsWith('vault://')}
                  >
                    {row.status === 'migrating' ? 'Migrating…' : isDone ? 'Migrated' : 'Migrate'}
                  </button>
                </div>
                {row.status === 'error' && row.error && (
                  <p className="form-hint" style={{ marginTop: 4, color: 'var(--status-dead)' }}>
                    {row.error}
                  </p>
                )}
                {isDone && (
                  <p className="form-hint" style={{ marginTop: 4, color: 'var(--status-running)' }}>
                    {'\u2713'} Stored at {row.targetRef}
                  </p>
                )}
              </div>
            );
          })}
        </div>
        <div className="dialog-footer">
          <button className="form-btn" onClick={onClose}>
            {pendingCount === 0 && rows.length > 0 ? 'Done' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  );
}
