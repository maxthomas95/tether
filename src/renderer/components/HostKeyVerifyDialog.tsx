import type { HostVerifyRequest } from '../../shared/types';

interface HostKeyVerifyDialogProps {
  request: HostVerifyRequest | null;
  onTrust: () => void;
  onReject: () => void;
}

function formatFingerprint(hex: string): string {
  // Standard SSH fingerprint shape: "SHA256:<hex>" — show in chunks for readability.
  const chunks: string[] = [];
  for (let i = 0; i < hex.length; i += 4) {
    chunks.push(hex.slice(i, i + 4));
  }
  return `SHA256:${chunks.join(':')}`;
}

export function HostKeyVerifyDialog({ request, onTrust, onReject }: HostKeyVerifyDialogProps) {
  if (!request) return null;

  const target = request.username
    ? `${request.username}@${request.host}:${request.port}`
    : `${request.host}:${request.port}`;

  return (
    <div className="dialog-overlay" onClick={onReject}>
      <div className="dialog" style={{ width: 520 }} onClick={e => e.stopPropagation()}>
        <div className="dialog-header">
          <span>Verify SSH host key</span>
          <button className="dialog-close" onClick={onReject}>&times;</button>
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
            <div style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 13 }}>{target}</div>
          </div>
          <div className="form-group">
            <label className="form-label">Fingerprint</label>
            <div
              style={{
                fontFamily: 'var(--font-mono, monospace)',
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
