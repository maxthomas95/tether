import { useState, useRef, useEffect } from 'react';
import type { SessionInfo, SessionState } from '../../../shared/types';
import { CliToolBadge } from '../CliToolBadge';
import { onKeyActivate, stopPropagationOnKey } from '../../utils/a11y';

interface SessionItemProps {
  session: SessionInfo;
  isActive: boolean;
  onClick: () => void;
  onStop: () => void;
  onKill: () => void;
  onRename: (label: string) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  /** When provided, the context menu shows "Resume previous conversation...". */
  onResumePrevious?: () => void;
  /** When true, render a small ↻ marker for sessions launched via resume. */
  showResumeBadge?: boolean;
  nested?: boolean;
  onDragStart?: (sessionId: string) => void;
  onDragEnd?: () => void;
}

export function SessionItem({ session, isActive, onClick, onStop, onKill, onRename, onRemove, onDuplicate, onResumePrevious, showResumeBadge, nested, onDragStart, onDragEnd }: SessionItemProps) {
  const [showMenu, setShowMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(session.label);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const isAlive = session.state !== 'stopped' && session.state !== 'dead';

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  useEffect(() => {
    if (!showMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showMenu]);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setShowMenu(true);
  };

  const submitRename = () => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== session.label) {
      onRename(trimmed);
    }
    setEditing(false);
  };

  return (
    <div
      className={`session-item ${isActive ? 'session-item--active' : ''} ${nested ? 'session-item--nested' : ''}`}
      onClick={onClick}
      onKeyDown={onKeyActivate(onClick)}
      role="button"
      tabIndex={0}
      onContextMenu={handleContextMenu}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/tether-session', session.id);
        e.dataTransfer.effectAllowed = 'copy';
        onDragStart?.(session.id);
      }}
      onDragEnd={() => onDragEnd?.()}
    >
      <span className={`status-dot status-dot--${getStatusClass(session.state)}`} />
      <div className="session-info">
        {editing ? (
          <input
            ref={inputRef}
            className="session-rename-input"
            value={editValue}
            onChange={e => setEditValue(e.target.value)}
            onBlur={submitRename}
            onKeyDown={e => {
              if (e.key === 'Enter') submitRename();
              if (e.key === 'Escape') setEditing(false);
            }}
            onClick={e => e.stopPropagation()}
          />
        ) : (
          <>
            <span className="session-label">
              {session.label}
              {showResumeBadge && session.resumed && (
                <span
                  title="Resumed from a previous chat"
                  style={{ marginLeft: 6, opacity: 0.7, fontSize: 11 }}
                >
                  ↻
                </span>
              )}
            </span>
            <span className="session-path">
              <CliToolBadge session={session} />
              <span className="session-path-text">{abbreviatePath(session.workingDir)}</span>
            </span>
          </>
        )}
      </div>

      {showMenu && (
        <div ref={menuRef} className="context-menu" onClick={e => e.stopPropagation()} onKeyDown={stopPropagationOnKey} role="menu" tabIndex={-1}>
          <div
            className="context-menu-item"
            role="menuitem"
            tabIndex={0}
            onClick={() => { setShowMenu(false); setEditing(true); setEditValue(session.label); }}
            onKeyDown={onKeyActivate(() => { setShowMenu(false); setEditing(true); setEditValue(session.label); })}
          >
            Rename
          </div>
          <div
            className="context-menu-item"
            role="menuitem"
            tabIndex={0}
            onClick={() => { setShowMenu(false); onDuplicate(); }}
            onKeyDown={onKeyActivate(() => { setShowMenu(false); onDuplicate(); })}
          >
            Duplicate
          </div>
          {onResumePrevious && (
            <div
              className="context-menu-item"
              role="menuitem"
              tabIndex={0}
              onClick={() => { setShowMenu(false); onResumePrevious(); }}
              onKeyDown={onKeyActivate(() => { setShowMenu(false); onResumePrevious(); })}
            >
              Resume previous conversation...
            </div>
          )}
          {isAlive && (
            <div
              className="context-menu-item"
              role="menuitem"
              tabIndex={0}
              onClick={() => { setShowMenu(false); onStop(); }}
              onKeyDown={onKeyActivate(() => { setShowMenu(false); onStop(); })}
            >
              Stop
            </div>
          )}
          {isAlive && (
            <div
              className="context-menu-item context-menu-item--danger"
              role="menuitem"
              tabIndex={0}
              onClick={() => { setShowMenu(false); onKill(); }}
              onKeyDown={onKeyActivate(() => { setShowMenu(false); onKill(); })}
            >
              Kill
            </div>
          )}
          <div
            className="context-menu-item context-menu-item--danger"
            role="menuitem"
            tabIndex={0}
            onClick={() => { setShowMenu(false); onRemove(); }}
            onKeyDown={onKeyActivate(() => { setShowMenu(false); onRemove(); })}
          >
            Remove
          </div>
        </div>
      )}
    </div>
  );
}

function getStatusClass(state: SessionState): string {
  switch (state) {
    case 'running':
    case 'starting':
      return 'running';
    case 'waiting':
      return 'waiting';
    case 'stopped':
    case 'dead':
      return 'dead';
    default:
      return 'idle';
  }
}

function abbreviatePath(p: string): string {
  const home = window.electronAPI.homeDir;
  if (home && p.startsWith(home)) {
    return '~' + p.slice(home.length).replace(/\\/g, '/');
  }
  const parts = p.split(/[\\/]/);
  return parts.length > 2 ? `.../${parts.slice(-2).join('/')}` : p;
}
