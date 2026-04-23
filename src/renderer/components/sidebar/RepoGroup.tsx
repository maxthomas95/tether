import { useState, useRef, useEffect } from 'react';
import { SessionItem } from './SessionItem';
import type { SessionInfo } from '../../../shared/types';
import { onKeyActivate, stopPropagationOnKey } from '../../utils/a11y';

interface RepoGroupProps {
  repoPath: string;
  environmentId: string;
  sessions: SessionInfo[];
  activeSessionId: string | null;
  pinned: boolean;
  onTogglePin: (environmentId: string, workingDir: string) => void;
  onDropRepoGroup: (environmentId: string, sourceDir: string, targetDir: string, position: 'above' | 'below') => void;
  onSelectSession: (id: string) => void;
  onStop: (id: string) => void;
  onKill: (id: string) => void;
  onRename: (id: string, label: string) => void;
  onRemove: (id: string) => void;
  onDuplicate: (id: string) => void;
  onResumePrevious?: (id: string) => void;
  canResumePrevious?: (session: SessionInfo) => boolean;
  showResumeBadge?: boolean;
  allowHelm?: boolean;
  onToggleHelm?: (id: string, enabled: boolean) => void;
  onDragStart?: (sessionId: string) => void;
  onDragEnd?: () => void;
}

export function RepoGroup({
  repoPath,
  environmentId,
  sessions,
  activeSessionId,
  pinned,
  onTogglePin,
  onDropRepoGroup,
  onSelectSession,
  onStop,
  onKill,
  onRename,
  onRemove,
  onDuplicate,
  onResumePrevious,
  canResumePrevious,
  showResumeBadge,
  allowHelm,
  onToggleHelm,
  onDragStart,
  onDragEnd,
}: RepoGroupProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [dropPosition, setDropPosition] = useState<'above' | 'below' | null>(null);
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close context menu on outside click
  useEffect(() => {
    if (!showMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showMenu]);

  const runningCount = sessions.filter(
    s => s.state === 'running' || s.state === 'waiting',
  ).length;

  const dirName = repoPath.split(/[\\/]/).pop() || repoPath;

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setShowMenu(true);
  };

  const handleDragStartGroup = (e: React.DragEvent) => {
    e.stopPropagation();
    e.dataTransfer.setData('application/tether-repogroup', JSON.stringify({
      environmentId,
      workingDir: repoPath,
    }));
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('application/tether-repogroup')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    setDropPosition(e.clientY < midY ? 'above' : 'below');
  };

  const handleDragLeave = () => {
    setDropPosition(null);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDropPosition(null);
    const raw = e.dataTransfer.getData('application/tether-repogroup');
    if (!raw) return;
    try {
      const source = JSON.parse(raw);
      if (source.environmentId !== environmentId) return;
      if (source.workingDir === repoPath) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const pos = e.clientY < midY ? 'above' : 'below';
      onDropRepoGroup(environmentId, source.workingDir, repoPath, pos);
    } catch { /* ignore bad data */ }
  };

  const headerClasses = [
    'repo-group-header',
    pinned ? 'repo-group-header--pinned' : '',
    dropPosition === 'above' ? 'repo-group-header--drop-above' : '',
    dropPosition === 'below' ? 'repo-group-header--drop-below' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className="repo-group">
      <div
        className={headerClasses}
        onClick={() => setCollapsed(c => !c)}
        onKeyDown={onKeyActivate(() => setCollapsed(c => !c))}
        role="button"
        tabIndex={0}
        onContextMenu={handleContextMenu}
        draggable
        onDragStart={handleDragStartGroup}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <span className="repo-group-chevron">
          {collapsed ? '\u25b8' : '\u25be'}
        </span>
        <span className="repo-group-name">{dirName}</span>
        <span className="repo-group-count">
          {sessions.length}
          {runningCount > 0 && (
            <span className="repo-group-active"> / {runningCount} active</span>
          )}
        </span>
        <span
          className="repo-group-pin-btn"
          title={pinned ? 'Unpin' : 'Pin to top'}
          role="button"
          tabIndex={0}
          onClick={(e) => { e.stopPropagation(); onTogglePin(environmentId, repoPath); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              onTogglePin(environmentId, repoPath);
            }
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style={{ display: 'block' }}>
            <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5v6l1 1 1-1v-6h5v-2z" />
          </svg>
        </span>
      </div>
      {showMenu && (
        <div ref={menuRef} className="context-menu" onClick={e => e.stopPropagation()} onKeyDown={stopPropagationOnKey} role="menu" tabIndex={-1}>
          <div
            className="context-menu-item"
            role="menuitem"
            tabIndex={0}
            onClick={() => {
              setShowMenu(false);
              onTogglePin(environmentId, repoPath);
            }}
            onKeyDown={onKeyActivate(() => {
              setShowMenu(false);
              onTogglePin(environmentId, repoPath);
            })}
          >
            {pinned ? 'Unpin' : 'Pin to top'}
          </div>
        </div>
      )}
      {!collapsed && sessions.map(session => (
        <SessionItem
          key={session.id}
          session={session}
          isActive={session.id === activeSessionId}
          onClick={() => onSelectSession(session.id)}
          onStop={() => onStop(session.id)}
          onKill={() => onKill(session.id)}
          onRename={(label) => onRename(session.id, label)}
          onRemove={() => onRemove(session.id)}
          onDuplicate={() => onDuplicate(session.id)}
          onResumePrevious={onResumePrevious && canResumePrevious?.(session) ? () => onResumePrevious(session.id) : undefined}
          showResumeBadge={showResumeBadge}
          allowHelm={allowHelm}
          onToggleHelm={onToggleHelm ? (enabled) => onToggleHelm(session.id, enabled) : undefined}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          nested
        />
      ))}
    </div>
  );
}
