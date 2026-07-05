import { useState, useRef, useEffect } from 'react';
import { SessionItem } from './SessionItem';
import type { SessionInfo, EnvironmentType } from '../../../shared/types';
import { onKeyActivate, stopPropagationOnKey } from '../../utils/a11y';
import type { PaneLocation } from '../../lib/layout-tree';
import { useBranchStatus } from '../../hooks/useBranchStatus';

interface RepoGroupProps {
  repoPath: string;
  environmentId: string;
  /** Local repo groups get a branch + uncommitted-change badge; SSH/Coder never do. */
  environmentType: EnvironmentType;
  sessions: SessionInfo[];
  activeSessionId: string | null;
  /** Set of session ids currently visible in some pane (i.e. mounted and not
   *  hidden behind a maximize). Sessions outside this set get the
   *  amber-with-bang affordance when they enter waiting state. */
  visibleSessionIds?: Set<string>;
  /** Sessions whose current waiting cycle the user has already acknowledged
   *  (by viewing). These do NOT bang even if invisible — Slack-style
   *  see-once-then-quiet. Permission prompts override this in the dot logic. */
  bangSuppressedIds?: Set<string>;
  pinned: boolean;
  onTogglePin: (environmentId: string, workingDir: string) => void;
  onDropRepoGroup: (environmentId: string, sourceDir: string, targetDir: string, position: 'above' | 'below') => void;
  onSelectSession: (id: string) => void;
  onStop: (id: string) => void;
  onRename: (id: string, label: string) => void;
  onRemove: (id: string) => void;
  onDuplicate: (id: string) => void;
  onResumePrevious?: (id: string) => void;
  canResumePrevious?: (session: SessionInfo) => boolean;
  showResumeBadge?: boolean;
  allowHelm?: boolean;
  onToggleHelm?: (id: string, enabled: boolean) => void;
  /** When provided, surfaces the "Mute notifications" toggle on each session row. */
  onToggleNotificationsMuted?: (id: string, muted: boolean) => void;
  onDragStart?: (sessionId: string) => void;
  onDragEnd?: () => void;
  /**
   * Reorder a session within this group. RepoGroup forwards the call enriched
   * with its env+dir context so the parent doesn't need to look them up.
   */
  onReorderSession?: (environmentId: string, workingDir: string, sourceSessionId: string, targetSessionId: string, position: 'above' | 'below') => void;
  onStopAllInGroup?: (environmentId: string, workingDir: string) => void;
  onRestartAllInGroup?: (environmentId: string, workingDir: string) => void;
  onClearAllInGroup?: (environmentId: string, workingDir: string) => void;
  /** Map of sessionId -> pane location for sessions currently mounted in the layout. */
  paneLocations?: Map<string, PaneLocation>;
  /** Map of paneId -> true when the pane is hidden by another maximized pane. */
  hiddenPaneIds?: Set<string>;
  /** Focus the pane at the given id (and un-maximize if it's hidden). */
  onFocusPane?: (paneId: string) => void;
  /**
   * Phase 2 stagger: index within the environment's group list, used by CSS
   * to delay the enter animation per row. Optional — falls back to 0.
   */
  staggerIndex?: number;
}

export function RepoGroup({
  repoPath,
  environmentId,
  environmentType,
  sessions,
  activeSessionId,
  visibleSessionIds,
  bangSuppressedIds,
  pinned,
  onTogglePin,
  onDropRepoGroup,
  onSelectSession,
  onStop,
  onRename,
  onRemove,
  onDuplicate,
  onResumePrevious,
  canResumePrevious,
  showResumeBadge,
  allowHelm,
  onToggleHelm,
  onToggleNotificationsMuted,
  onDragStart,
  onDragEnd,
  onReorderSession,
  onStopAllInGroup,
  onRestartAllInGroup,
  onClearAllInGroup,
  paneLocations,
  hiddenPaneIds,
  onFocusPane,
  staggerIndex,
}: RepoGroupProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [dropPosition, setDropPosition] = useState<'above' | 'below' | null>(null);
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const branchStatus = useBranchStatus(repoPath, environmentType === 'local');

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
    <div
      className="repo-group"
      style={staggerIndex != null
        ? ({ '--stagger-index': staggerIndex } as React.CSSProperties)
        : undefined}
    >
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
        {branchStatus && (
          <span
            className="repo-group-branch"
            title={`Branch ${branchStatus.branch}${branchStatus.dirtyCount > 0 ? ` — ${branchStatus.dirtyCount} uncommitted change(s)` : ''}`}
          >
            {branchStatus.branch}
            {branchStatus.dirtyCount > 0 && <span className="repo-group-dirty">●{branchStatus.dirtyCount}</span>}
          </span>
        )}
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
          {(onStopAllInGroup || onRestartAllInGroup || onClearAllInGroup) && (
            <div className="context-menu-separator" role="separator" />
          )}
          {onStopAllInGroup && (
            <div
              className={`context-menu-item ${runningCount === 0 ? 'context-menu-item--disabled' : ''}`}
              role="menuitem"
              tabIndex={runningCount === 0 ? -1 : 0}
              aria-disabled={runningCount === 0 || undefined}
              onClick={() => {
                if (runningCount === 0) return;
                setShowMenu(false);
                onStopAllInGroup(environmentId, repoPath);
              }}
              onKeyDown={onKeyActivate(() => {
                if (runningCount === 0) return;
                setShowMenu(false);
                onStopAllInGroup(environmentId, repoPath);
              })}
            >
              Stop all{runningCount > 0 ? ` (${runningCount})` : ''}
            </div>
          )}
          {onRestartAllInGroup && (
            <div
              className={`context-menu-item ${sessions.length === 0 ? 'context-menu-item--disabled' : ''}`}
              role="menuitem"
              tabIndex={sessions.length === 0 ? -1 : 0}
              aria-disabled={sessions.length === 0 || undefined}
              onClick={() => {
                if (sessions.length === 0) return;
                setShowMenu(false);
                onRestartAllInGroup(environmentId, repoPath);
              }}
              onKeyDown={onKeyActivate(() => {
                if (sessions.length === 0) return;
                setShowMenu(false);
                onRestartAllInGroup(environmentId, repoPath);
              })}
            >
              Restart all
            </div>
          )}
          {onClearAllInGroup && (
            <div
              className={`context-menu-item context-menu-item--danger ${sessions.length === 0 ? 'context-menu-item--disabled' : ''}`}
              role="menuitem"
              tabIndex={sessions.length === 0 ? -1 : 0}
              aria-disabled={sessions.length === 0 || undefined}
              onClick={() => {
                if (sessions.length === 0) return;
                setShowMenu(false);
                onClearAllInGroup(environmentId, repoPath);
              }}
              onKeyDown={onKeyActivate(() => {
                if (sessions.length === 0) return;
                setShowMenu(false);
                onClearAllInGroup(environmentId, repoPath);
              })}
            >
              Clear all
            </div>
          )}
        </div>
      )}
      {!collapsed && sessions.map(session => {
        const location = paneLocations?.get(session.id);
        return (
          <SessionItem
            key={session.id}
            session={session}
            isActive={session.id === activeSessionId}
            isVisibleInLayout={visibleSessionIds?.has(session.id) ?? false}
            bangSuppressed={bangSuppressedIds?.has(session.id) ?? false}
            onClick={() => onSelectSession(session.id)}
            onStop={() => onStop(session.id)}
            onRename={(label) => onRename(session.id, label)}
            onRemove={() => onRemove(session.id)}
            onDuplicate={() => onDuplicate(session.id)}
            onResumePrevious={onResumePrevious && canResumePrevious?.(session) ? () => onResumePrevious(session.id) : undefined}
            showResumeBadge={showResumeBadge}
            allowHelm={allowHelm}
            onToggleHelm={onToggleHelm ? (enabled) => onToggleHelm(session.id, enabled) : undefined}
            onToggleNotificationsMuted={onToggleNotificationsMuted ? (muted) => onToggleNotificationsMuted(session.id, muted) : undefined}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onReorderDrop={
              onReorderSession
                ? (sourceId, targetId, position) =>
                    onReorderSession(environmentId, repoPath, sourceId, targetId, position)
                : undefined
            }
            paneLocation={location}
            paneHidden={location ? hiddenPaneIds?.has(location.paneId) : false}
            onFocusPane={onFocusPane}
            nested
          />
        );
      })}
    </div>
  );
}
