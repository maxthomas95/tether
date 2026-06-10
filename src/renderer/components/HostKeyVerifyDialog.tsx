import { useRef } from 'react';
import type { HostVerifyRequest } from '../../shared/types';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { useFocusTrap } from '../hooks/useFocusTrap';

interface HostKeyVerifyDialogProps {
  request: HostVerifyRequest | null;
  onTrust: () => void;
  onReject: () => void;
}

function formatFingerprint(fingerprint: string): string {
  return fingerprint.startsWith('SHA256:') ? fingerprint : `SHA256:${fingerprint}`;
}

export function HostKeyVerifyDialog({ request, onTrust, onReject }: HostKeyVerifyDialogProps) {
  useEscapeKey(onReject, request !== null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, request !== null);
  if (!request) return null;

  const target = request.username
    ? `${request.username}@${request.host}:${request.port}`
    : `${request.host}:${request.port}`;

  return (
    <div
      className="dialog-overlay"
      role="presentation"
      onClick={(e) => { if (e.target === e.currentTarget) onReject(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') onReject(); }}
    >
      <div ref={dialogRef} className="dialog" role="dialog" aria-modal="true" aria-label="Verify SSH host key" style={{ width: 520 }}>
        <div className="dialog-header">
          <span>Verify SSH host key</span>
          <button className="dialog-close" aria-label="Close dialog" onClick={onReject}>&times;</button>
        </div>
        <div className="dialog-body" style={{ padding: '16px 20px' }}>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.5 }}>
            Tether has never connected to this host before. Verify the fingerprint
            out-of-band (ask the server admin, check a record, etc.) before
            trusting it. Trusting an attacker's fingerprint here is the same as
            handing them your credentials.
          </div>
          <div className="form-group">
            <label className="form-label">Host</label>
            <div style={{ fontFamily: 'var(--font-mono-ui, monospace)', fontSize: 13 }}>{target}</div>
          </div>
          <div className="form-group">
            <label className="form-label">Fingerprint</label>
            <div
              style={{
                fontFamily: 'var(--font-mono-ui, monospace)',
                fontSize: 12,
                wordBreak: 'break-all',
                padding: 8,
                border: '1px solid var(--border-color)',
                borderRadius: 4,
                background: 'var(--bg-sidebar)',
              }}
            >
              {formatFingerprint(request.keyHash)}
            </div>
          </div>
        </div>
        <div className="dialog-footer">
          <button className="form-btn" onClick={onReject}>Reject</button>
          <button
            className="form-btn"
            style={{ background: 'var(--accent)', color: 'var(--bg-primary)' }}
            onClick={onTrust}
          >
            Trust always
          </button>
        </div>
      </div>
    </div>
  );
}
