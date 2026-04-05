import { useState, useRef, useEffect } from 'react';
import type { SessionInfo, SessionState } from '../../../shared/types';

interface SessionItemProps {
  session: SessionInfo;
  isActive: boolean;
  onClick: () => void;
  onStop: () => void;
  onKill: () => void;
  onRename: (label: string) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  nested?: boolean;
}

export function SessionItem({ session, isActive, onClick, onStop, onKill, onRename, onRemove, onDuplicate, nested }: SessionItemProps) {
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
      onContextMenu={handleContextMenu}
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
            <span className="session-label">{session.label}</span>
            <span className="session-path">{abbreviatePath(session.workingDir)}</span>
          </>
        )}
      </div>

      {showMenu && (
        <div ref={menuRef} className="context-menu" onClick={e => e.stopPropagation()}>
          <div className="context-menu-item" onClick={() => { setShowMenu(false); setEditing(true); setEditValue(session.label); }}>
            Rename
          </div>
          <div className="context-menu-item" onClick={() => { setShowMenu(false); onDuplicate(); }}>
            Duplicate
          </div>
          {isAlive && (
            <div className="context-menu-item" onClick={() => { setShowMenu(false); onStop(); }}>
              Stop
            </div>
          )}
          {isAlive && (
            <div className="context-menu-item context-menu-item--danger" onClick={() => { setShowMenu(false); onKill(); }}>
              Kill
            </div>
          )}
          <div className="context-menu-item context-menu-item--danger" onClick={() => { setShowMenu(false); onRemove(); }}>
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
