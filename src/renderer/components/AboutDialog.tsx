import { useState } from 'react';
import logoSrc from '../assets/logo.png';
import { useEscapeKey } from '../hooks/useEscapeKey';

interface AboutDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

type ExportState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; path: string }
  | { kind: 'error'; message: string };

export function AboutDialog({ isOpen, onClose }: AboutDialogProps) {
  useEscapeKey(onClose, isOpen);
  const [exportState, setExportState] = useState<ExportState>({ kind: 'idle' });

  if (!isOpen) return null;

  const handleExportDiagnostics = async () => {
    setExportState({ kind: 'running' });
    try {
      const result = await window.electronAPI.diagnostics.export();
      if (result.ok && result.path) {
        setExportState({ kind: 'done', path: result.path });
      } else if (result.error === 'cancelled') {
        setExportState({ kind: 'idle' });
      } else {
        setExportState({ kind: 'error', message: result.error || 'Unknown error' });
      }
    } catch (err) {
      setExportState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

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
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 16 }}>
            Desktop session multiplexer for Claude Code and Codex CLI.
            <br />
            Manage multiple sessions across local, SSH, and container environments.
          </div>
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, marginTop: 4 }}>
            <button
              className="form-btn"
              onClick={handleExportDiagnostics}
              disabled={exportState.kind === 'running'}
              style={{ minWidth: 200 }}
            >
              {exportState.kind === 'running' ? 'Exporting…' : 'Export diagnostics for support'}
            </button>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 8, lineHeight: 1.5 }}>
              {exportState.kind === 'idle' && 'Bundles logs + a scrubbed copy of your settings into a zip you can attach to a bug report.'}
              {exportState.kind === 'done' && (
                <span style={{ color: 'var(--accent-success, #22C55E)' }}>
                  Saved to {exportState.path}
                </span>
              )}
              {exportState.kind === 'error' && (
                <span style={{ color: 'var(--accent-danger, #EF4444)' }}>
                  Export failed: {exportState.message}
                </span>
              )}
              {exportState.kind === 'running' && 'Bundling logs and scrubbing secrets…'}
            </div>
          </div>
        </div>
        <div className="dialog-footer">
          <button className="form-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
