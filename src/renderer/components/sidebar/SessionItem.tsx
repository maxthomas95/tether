import { useState, useRef, useEffect } from 'react';
import type { SessionInfo, SessionState } from '../../../shared/types';
import { CliToolBadge } from '../CliToolBadge';
import { PaneLocationBadge } from './PaneLocationBadge';
import { onKeyActivate, stopPropagationOnKey } from '../../utils/a11y';
import { abbreviatePath } from '../../utils/paths';
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
  /** When provided, render the "Mute notifications" / "Unmute notifications" context-menu toggle. */
  onToggleNotificationsMuted?: (muted: boolean) => void;
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
  /**
   * Returns the last few lines of this session's terminal buffer for the
   * hover preview popover, or `[]` if there's nothing to show. Omitted
   * disables the preview entirely.
   */
  getPreviewLines?: (sessionId: string) => string[];
}

/** Hover-intent delay before the preview popover is requested and shown. */
const PREVIEW_HOVER_DELAY_MS = 350;

/**
 * Module-local snapshot of the session being dragged for reorder. Set on
 * dragStart, cleared on dragEnd. dragOver consults this so we can show the
 * indicator only when source and target are in the same repo group —
 * dataTransfer.getData isn't readable until drop in Electron's HTML5 DnD.
 */
let activeReorderSource: { id: string; environmentId: string | null; workingDir: string } | null = null;

export function SessionItem({ session, isActive, isVisibleInLayout, bangSuppressed, onClick, onStop, onRename, onRemove, onDuplicate, onResumePrevious, showResumeBadge, allowHelm, onToggleHelm, onToggleNotificationsMuted, nested, onDragStart, onDragEnd, onReorderDrop, paneLocation, paneHidden, onFocusPane, getPreviewLines }: SessionItemProps) {
  const [showMenu, setShowMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(session.label);
  const [reorderDropPosition, setReorderDropPosition] = useState<'above' | 'below' | null>(null);
  const [preview, setPreview] = useState<{ lines: string[]; top: number; left: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // Clear any pending hover-intent timer on unmount so it doesn't fire
  // setPreview after the row is gone.
  useEffect(() => {
    return () => {
      if (hoverTimerRef.current !== null) clearTimeout(hoverTimerRef.current);
    };
  }, []);

  const clearHoverTimer = () => {
    if (hoverTimerRef.current !== null) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  };

  const hidePreview = () => {
    clearHoverTimer();
    setPreview(null);
  };

  const handleMouseEnterRow = () => {
    if (!getPreviewLines) return;
    clearHoverTimer();
    hoverTimerRef.current = setTimeout(() => {
      hoverTimerRef.current = null;
      const lines = getPreviewLines(session.id);
      if (lines.length === 0) return;
      const rect = rowRef.current?.getBoundingClientRect();
      if (!rect) return;
      // Clamp so a row near the bottom edge can't push the popover
      // off-screen (~6 lines + padding ≈ 140px).
      const top = Math.max(8, Math.min(rect.top, window.innerHeight - 140));
      setPreview({ lines, top, left: rect.right + 8 });
    }, PREVIEW_HOVER_DELAY_MS);
  };

  const handleRowClick = () => {
    hidePreview();
    onClick();
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    hidePreview();
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
      ref={rowRef}
      className={itemClasses}
      onClick={handleRowClick}
      onKeyDown={onKeyActivate(handleRowClick)}
      role="button"
      tabIndex={0}
      onContextMenu={handleContextMenu}
      onMouseEnter={handleMouseEnterRow}
      onMouseLeave={hidePreview}
      draggable
      onDragStart={(e) => {
        // Drag suppresses the mouseleave that would normally clear the
        // preview — hide it explicitly so it can't linger over the drag.
        hidePreview();
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
        role="status"
        aria-label={getStatusLabel(session.state, session.waitingReason, isVisibleInLayout, bangSuppressed)}
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
              {session.notificationsMuted && (
                <span
                  title="Notifications muted"
                  style={{ marginLeft: 6, opacity: 0.55, fontSize: 11 }}
                >
                  🔕
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
          {onToggleNotificationsMuted && (
            <div
              className="context-menu-item"
              role="menuitem"
              tabIndex={0}
              onClick={() => { setShowMenu(false); onToggleNotificationsMuted(!session.notificationsMuted); }}
              onKeyDown={onKeyActivate(() => { setShowMenu(false); onToggleNotificationsMuted(!session.notificationsMuted); })}
              title={session.notificationsMuted ? 'Re-enable desktop notifications for this session' : 'Stop showing desktop notifications for this session'}
            >
              {session.notificationsMuted ? 'Unmute notifications' : 'Mute notifications'}
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

      {preview && (
        <div
          className="session-preview-popover"
          style={{ top: preview.top, left: preview.left }}
          aria-hidden="true"
        >
          {preview.lines.map((line, i) => (
            <div key={i} className="session-preview-popover-line">{line}</div>
          ))}
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
      if (waitingReason === 'permission') return 'waiting-permission';
      if (isVisibleInLayout === false && !bangSuppressed) return 'waiting-permission';
      return 'waiting';
    case 'idle':
      // Idle is the byte-level "30s of further silence" reclassification of
      // a waiting session. If the user never acked the original wait, keep
      // the bang going — fading to grey would silently hide the unread
      // alert and the user would never know to come back. Once acked, the
      // dot proceeds to its normal grey appearance like any quiet session.
      if (isVisibleInLayout === false && !bangSuppressed) return 'waiting-permission';
      return 'idle';
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
  if (state !== 'waiting' && state !== 'idle') return undefined;
  if (waitingReason === 'permission') return 'Waiting on a permission prompt — switch in to respond';
  if (isVisibleInLayout === false && !bangSuppressed) return 'This session is waiting and not currently visible';
  return undefined;
}

/**
 * Always-present screen-reader label for the status dot. Unlike the tooltip
 * (which only surfaces extra context for waiting/idle), every visual state
 * gets a spoken label. The bang/waiting-permission affordance — which renders
 * as a "!" pseudo-element — is announced explicitly as waiting on a permission
 * prompt so non-sighted users get the same call-out as the visual bang.
 */
function getStatusLabel(
  state: SessionState,
  waitingReason: 'idle' | 'permission' | undefined,
  isVisibleInLayout: boolean | undefined,
  bangSuppressed: boolean | undefined,
): string {
  // Mirror getStatusClass: a permission prompt, or an un-acked invisible wait,
  // shows the bang affordance.
  const showsBang =
    (state === 'waiting' || state === 'idle') &&
    (waitingReason === 'permission' || (isVisibleInLayout === false && !bangSuppressed));
  if (showsBang) {
    return waitingReason === 'permission'
      ? 'Status: waiting on a permission prompt'
      : 'Status: waiting (not currently visible)';
  }
  switch (state) {
    case 'running':
    case 'starting':
      return 'Status: running';
    case 'waiting':
      return 'Status: waiting for your input';
    case 'idle':
      return 'Status: idle';
    case 'stopped':
    case 'dead':
      return 'Status: stopped';
    default:
      return 'Status: idle';
  }
}
