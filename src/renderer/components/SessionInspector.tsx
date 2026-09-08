import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { EnvironmentInfo, SessionUsage } from '../../shared/types';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { Icon } from './Icon';
import {
  buildInspectorViewModel,
  hookHealthLabel,
  shortenModel,
  type InspectableSession,
  type InspectorConfig,
} from '../utils/session-inspector';

interface SessionInspectorProps {
  nativeSessionId?: string;
  tetherSessionId?: string | null;
  session?: InspectableSession;
  environment?: EnvironmentInfo;
  usage: SessionUsage | null;
  config: InspectorConfig;
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
}

export function SessionInspector({
  nativeSessionId,
  tetherSessionId,
  session,
  environment,
  usage,
  config,
  isOpen,
  onOpen,
  onClose,
}: SessionInspectorProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, isOpen);
  const view = buildInspectorViewModel({ nativeSessionId, tetherSessionId, session, environment, usage, config });

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  return (
    <>
      <button
        type="button"
        className="pane-status-strip-details"
        onClick={onOpen}
        title="Show session details"
        aria-label="Show session details"
      >
        <Icon name="more" size={14} />
      </button>
      {isOpen && createPortal(
        <div className="dialog-overlay session-inspector-overlay" onMouseDown={onClose} role="presentation">
          <div
            ref={dialogRef}
            className="dialog session-inspector-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Session details"
            tabIndex={-1}
            onMouseDown={event => event.stopPropagation()}
          >
            <div className="dialog-header">
              <div>
                <h2>Session details</h2>
                <div className="session-inspector-subtitle">
                  {view.stripModel ? shortenModel(view.stripModel) : 'Unknown model'} · {hookHealthLabel(view.hookHealth)}
                </div>
              </div>
              <button className="dialog-close" aria-label="Close dialog" onClick={onClose}>&times;</button>
            </div>
            <div className="dialog-body session-inspector-body">
              <dl className="session-inspector-grid">
                {view.rows.map(row => (
                  <div className="session-inspector-row" key={row.label}>
                    <dt>{row.label}</dt>
                    <dd className={row.muted ? 'session-inspector-muted' : undefined}>{row.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <div className="dialog-footer">
              <button type="button" className="form-btn" onClick={onClose}>Close</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
