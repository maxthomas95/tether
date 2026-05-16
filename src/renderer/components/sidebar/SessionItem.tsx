import { useState, useRef, useEffect } from 'react';
import type { SessionInfo, SessionState } from '../../../shared/types';
import { CliToolBadge } from '../CliToolBadge';
import { PaneLocationBadge } from './PaneLocationBadge';
import { onKeyActivate, stopPropagationOnKey } from '../../utils/a11y';
import type { PaneLocation } from '../../lib/layout-tree';

interface SessionItemProps {
  session: SessionInfo;
  isActive: boolean;
  /** True when the session is mounted in a pane currently visible to the user
   *  (i.e. mounted AND not hidden behind a maximized pane). When false, a
   *  session in 'waiting' state gets the amber-with-bang affordance — the
   *  user can't see the session itself, so the dot has to call out. */
  isVisibleInLayout?: boolean;
  /** True when the user has already acknowledged this session's current
   *  waiting cycle by viewing it. Suppresses the bang even when the session
   *  is invisible (Slack/Discord style: see-once-then-quiet). Permission
   *  prompts override this — those always bang. */
  bangSuppressed?: boolean;
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
  /** When true, render the "Enable/Disable Helm" context menu item (global Allow Helm is on). */
  allowHelm?: boolean;
  /** Called when the user toggles Helm on this session. */
  onToggleHelm?: (enabled: boolean) => void;
  nested?: boolean;
  onDragStart?: (sessionId: string) => void;
  onDragEnd?: () => void;
  /**
   * Called when another session in the same repo group is dropped onto this
   * one. The parent group resolves source vs. target and persists the new order.
   */
  onReorderDrop?: (sourceSessionId: string, targetSessionId: string, position: 'above' | 'below') => void;
  /** When this session occupies a pane in the active layout, where it is. */
  paneLocation?: PaneLocation;
  /** True when the session's pane is currently hidden behind another maximized pane. */
  paneHidden?: boolean;
  /** Focus this session's pane (and un-maximize if needed). */
  onFocusPane?: (paneId: string) => void;
}

/**
 * Module-local snapshot of the session being dragged for reorder. Set on
 * dragStart, cleared on dragEnd. dragOver consults this so we can show the
 * indicator only when source and target are in the same repo group —
 * dataTransfer.getData isn't readable until drop in Electron's HTML5 DnD.
 */
let activeReorderSource: { id: string; environmentId: string | null; workingDir: string } | null = null;

export function SessionItem({ session, isActive, isVisibleInLayout, bangSuppressed, onClick, onStop, onKill, onRename, onRemove, onDuplicate, onResumePrevious, showResumeBadge, allowHelm, onToggleHelm, nested, onDragStart, onDragEnd, onReorderDrop, paneLocation, paneHidden, onFocusPane }: SessionItemProps) {
  const [showMenu, setShowMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(session.label);
  const [reorderDropPosition, setReorderDropPosition] = useState<'above' | 'below' | null>(null);
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

  /**
   * Re-checked inline in handlers (not at render) because activeReorderSource
   * is module-local and mutates without triggering a re-render — render-time
   * closure would be stale.
   */
  const isReorderEligible = (): boolean =>
    !!onReorderDrop &&
    !!activeReorderSource &&
    activeReorderSource.id !== session.id &&
    activeReorderSource.environmentId === (session.environmentId ?? null) &&
    activeReorderSource.workingDir === session.workingDir;

  const itemClasses = [
    'session-item',
    isActive ? 'session-item--active' : '',
    nested ? 'session-item--nested' : '',
    reorderDropPosition === 'above' ? 'session-item--drop-above' : '',
    reorderDropPosition === 'below' ? 'session-item--drop-below' : '',
  ].filter(Boolean).join(' ');

  return (
    <div
      className={itemClasses}
      onClick={onClick}
      onKeyDown={onKeyActivate(onClick)}
      role="button"
      tabIndex={0}
      onContextMenu={handleContextMenu}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/tether-session', session.id);
        // Second payload signals reorder intent — separate type so existing
        // pane-drop receivers (TerminalPane / DropZoneOverlay) ignore it.
        e.dataTransfer.setData('application/tether-session-reorder', session.id);
        e.dataTransfer.effectAllowed = 'copyMove';
        activeReorderSource = {
          id: session.id,
          environmentId: session.environmentId ?? null,
          workingDir: session.workingDir,
        };
        onDragStart?.(session.id);
      }}
      onDragEnd={() => {
        activeReorderSource = null;
        setReorderDropPosition(null);
        onDragEnd?.();
      }}
      onDragOver={(e) => {
        if (!isReorderEligible()) return;
        if (!e.dataTransfer.types.includes('application/tether-session-reorder')) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        const rect = e.currentTarget.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        setReorderDropPosition(e.clientY < midY ? 'above' : 'below');
      }}
      onDragLeave={() => setReorderDropPosition(null)}
      onDrop={(e) => {
        if (!isReorderEligible() || !onReorderDrop) {
          setReorderDropPosition(null);
          return;
        }
        const sourceId = e.dataTransfer.getData('application/tether-session-reorder');
        if (!sourceId || sourceId === session.id) {
          setReorderDropPosition(null);
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        const rect = e.currentTarget.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        const pos: 'above' | 'below' = e.clientY < midY ? 'above' : 'below';
        setReorderDropPosition(null);
        onReorderDrop(sourceId, session.id, pos);
      }}
    >
      <span
        className={`status-dot status-dot--${getStatusClass(session.state, session.waitingReason, isVisibleInLayout, bangSuppressed)}`}
        title={getStatusTooltip(session.state, session.waitingReason, isVisibleInLayout, bangSuppressed)}
      />
      <div className="session-info">
        {editing ? (
          <input
            ref={inputRef}
            className="session-rename-input"
            value={editValue}
            onChange={e => setEditValue(e.target.value)}
            onBlur={submitRename}
            onKeyDown={e => {
              // Stop bubbling so the parent's onKeyActivate (which treats
              // Space/Enter as a click) doesn't swallow the spacebar or
              // refocus the terminal and blur us out of rename mode.
              e.stopPropagation();
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
              {session.helmEnabled && allowHelm && (
                <span
                  title="Helm enabled — can dispatch child sessions"
                  style={{ marginLeft: 6, opacity: 0.75, fontSize: 11 }}
                >
                  ⚓
                </span>
              )}
              {session.parentSessionId && (
                <span
                  title="Dispatched by another session via Helm"
                  style={{ marginLeft: 6, opacity: 0.75, fontSize: 11 }}
                >
                  🪝
                </span>
              )}
            </span>
            <span className="session-path">
              <CliToolBadge session={session} />
              <span className="session-path-text">{abbreviatePath(session.workingDir)}</span>
              {paneLocation && onFocusPane && (
                <PaneLocationBadge
                  location={paneLocation}
                  hidden={!!paneHidden}
                  onClick={() => onFocusPane(paneLocation.paneId)}
                />
              )}
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
          {allowHelm && onToggleHelm && (
            <div
              className="context-menu-item"
              role="menuitem"
              tabIndex={0}
              onClick={() => { setShowMenu(false); onToggleHelm(!session.helmEnabled); }}
              onKeyDown={onKeyActivate(() => { setShowMenu(false); onToggleHelm(!session.helmEnabled); })}
              title={session.helmEnabled ? 'Restart session to unwire the Helm MCP' : 'Restart session to wire the Helm MCP'}
            >
              {session.helmEnabled ? 'Disable Helm' : 'Enable Helm'}
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

function getStatusClass(
  state: SessionState,
  waitingReason: 'idle' | 'permission' | undefined,
  isVisibleInLayout: boolean | undefined,
  bangSuppressed: boolean | undefined,
): string {
  switch (state) {
    case 'running':
    case 'starting':
      return 'running';
    case 'waiting':
      // Bang priority:
      //   1. permission_prompt → always bang (Claude is genuinely blocked,
      //      the user MUST respond — see-once-then-quiet doesn't apply)
      //   2. invisible AND user hasn't acked this waiting cycle → bang
      //   3. visible OR user already acked → plain amber
      // Acks reset on every state transition into/out of waiting, so a new
      // turn produces a fresh bang.
      if (waitingReason === 'permission') return 'waiting-permission';
      if (isVisibleInLayout === false && !bangSuppressed) return 'waiting-permission';
      return 'waiting';
    case 'stopped':
    case 'dead':
      return 'dead';
    default:
      return 'idle';
  }
}

function getStatusTooltip(
  state: SessionState,
  waitingReason: 'idle' | 'permission' | undefined,
  isVisibleInLayout: boolean | undefined,
  bangSuppressed: boolean | undefined,
): string | undefined {
  if (state !== 'waiting') return undefined;
  if (waitingReason === 'permission') return 'Waiting on a permission prompt — switch in to respond';
  if (isVisibleInLayout === false && !bangSuppressed) return 'This session is waiting and not currently visible';
  return undefined;
}

function abbreviatePath(p: string): string {
  const home = window.electronAPI.homeDir;
  if (home && p.startsWith(home)) {
    return '~' + p.slice(home.length).replace(/\\/g, '/');
  }
  const parts = p.split(/[\\/]/);
  return parts.length > 2 ? `.../${parts.slice(-2).join('/')}` : p;
}
