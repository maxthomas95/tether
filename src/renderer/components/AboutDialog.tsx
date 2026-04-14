import logoSrc from '../assets/logo.png';
import { useEscapeKey } from '../hooks/useEscapeKey';

interface AboutDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function AboutDialog({ isOpen, onClose }: AboutDialogProps) {
  useEscapeKey(onClose, isOpen);
  if (!isOpen) return null;

  return (
    <div
      className="dialog-overlay"
      role="presentation"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
    >
      <div className="dialog" style={{ width: 420 }}>
        <div className="dialog-header">
          <span>About Tether</span>
          <button className="dialog-close" onClick={onClose}>&times;</button>
        </div>
        <div className="dialog-body" style={{ textAlign: 'center', padding: '20px 20px 16px' }}>
          <img src={logoSrc} alt="Tether" style={{ width: 64, height: 64, marginBottom: 12 }} />
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Tether</div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
            Version {__APP_VERSION__}
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            Desktop session multiplexer for Claude Code and Codex CLI.
            <br />
            Manage multiple sessions across local, SSH, and container environments.
          </div>
        </div>
        <div className="dialog-footer">
          <button className="form-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
