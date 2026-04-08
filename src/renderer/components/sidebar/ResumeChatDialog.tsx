import { useEffect, useState } from 'react';
import type { TranscriptInfo } from '../../../shared/types';

interface ResumeChatDialogProps {
  isOpen: boolean;
  workingDir: string;
  /** ID of the transcript currently in use by the source session, if any. */
  currentTranscriptId?: string;
  onClose: () => void;
  onPick: (transcriptId: string) => void;
}

function formatRelativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return iso;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function ResumeChatDialog({ isOpen, workingDir, currentTranscriptId, onClose, onPick }: ResumeChatDialogProps) {
  const [transcripts, setTranscripts] = useState<TranscriptInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    setError(null);
    window.electronAPI.transcripts.list(workingDir)
      .then(setTranscripts)
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [isOpen, workingDir]);

  if (!isOpen) return null;

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog dialog--wide" onClick={e => e.stopPropagation()}>
        <div className="dialog-header">
          <span>Resume previous chat</span>
          <button className="dialog-close" onClick={onClose}>&times;</button>
        </div>
        <div className="dialog-body" style={{ maxHeight: '60vh', overflowY: 'auto' }}>
          <p className="form-hint" style={{ marginBottom: 12 }}>
            Recent Claude conversations in <code>{workingDir}</code>. Picking one starts a new session
            that resumes that chat.
          </p>

          {loading && <p className="form-hint">Loading…</p>}
          {error && <p className="form-hint" style={{ color: 'var(--status-dead)' }}>{error}</p>}
          {!loading && !error && transcripts.length === 0 && (
            <p className="form-hint">No previous chats found for this directory.</p>
          )}

          {transcripts.map(t => {
            const isCurrent = t.id === currentTranscriptId;
            return (
              <div
                key={t.id}
                className="transcript-row"
                onClick={() => { if (!isCurrent) { onPick(t.id); onClose(); } }}
                style={{
                  padding: '10px 12px',
                  borderBottom: '1px solid var(--border-color)',
                  cursor: isCurrent ? 'default' : 'pointer',
                  opacity: isCurrent ? 0.55 : 1,
                }}
                onMouseEnter={e => { if (!isCurrent) (e.currentTarget as HTMLDivElement).style.background = 'var(--bg-hover, rgba(255,255,255,0.04))'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = ''; }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <span style={{ fontSize: 13, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.preview || <em style={{ opacity: 0.6 }}>(no user prompt yet)</em>}
                  </span>
                  <span className="form-hint" style={{ flexShrink: 0 }}>
                    {formatRelativeTime(t.mtime)}
                    {isCurrent && ' · current'}
                  </span>
                </div>
                <div className="form-hint" style={{ fontSize: 10, marginTop: 2, fontFamily: 'monospace' }}>
                  {t.id}
                </div>
              </div>
            );
          })}
        </div>
        <div className="dialog-footer">
          <button className="form-btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
