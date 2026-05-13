import { useEffect } from 'react';

export type PaneDirection = 'left' | 'right' | 'up' | 'down';

interface ShortcutActions {
  onNewSession: () => void;
  onSwitchSession: (index: number) => void;
  onNextSession: () => void;
  onPrevSession: () => void;
  onToggleSidebar: () => void;
  onStopSession: () => void;
  onOpenSettings: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onFocusPaneDirection: (direction: PaneDirection) => void;
  onSwapPaneDirection: (direction: PaneDirection) => void;
}

const ARROW_DIRECTIONS: Record<string, PaneDirection> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
};

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.classList.contains('xterm-helper-textarea')) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function useKeyboardShortcuts(actions: ShortcutActions) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;

      if (ctrl && !e.altKey) {
        // Ctrl+N — new session
        if (e.key === 'n' && !e.shiftKey) {
          e.preventDefault();
          actions.onNewSession();
          return;
        }

        // Ctrl+B — toggle sidebar
        if (e.key === 'b' && !e.shiftKey) {
          e.preventDefault();
          actions.onToggleSidebar();
          return;
        }

        // Ctrl+W — stop current session
        if (e.key === 'w' && !e.shiftKey) {
          e.preventDefault();
          actions.onStopSession();
          return;
        }

        // Ctrl+, — open settings
        if (e.key === ',') {
          e.preventDefault();
          actions.onOpenSettings();
          return;
        }

        // Ctrl+= / Ctrl++ — window zoom in
        if (e.key === '=' || e.key === '+') {
          e.preventDefault();
          actions.onZoomIn();
          return;
        }

        // Ctrl+- — window zoom out
        if (e.key === '-') {
          e.preventDefault();
          actions.onZoomOut();
          return;
        }

        // Ctrl+0 — reset window zoom
        if (e.key === '0') {
          e.preventDefault();
          actions.onZoomReset();
          return;
        }

        // Ctrl+1-9 — switch to session by index
        const num = parseInt(e.key);
        if (num >= 1 && num <= 9) {
          e.preventDefault();
          actions.onSwitchSession(num - 1);
          return;
        }

        // Ctrl+ArrowDown — next session
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          actions.onNextSession();
          return;
        }

        // Ctrl+ArrowUp — previous session
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          actions.onPrevSession();
          return;
        }
        return;
      }

      // Alt+Arrow — directional pane focus; Alt+Shift+Arrow — swap with neighbor.
      // Guarded so non-xterm editable fields (inline rename, dialog inputs) keep native behavior.
      if (e.altKey && !ctrl) {
        const direction = ARROW_DIRECTIONS[e.key];
        if (!direction) return;
        if (isEditableTarget(e.target)) return;
        e.preventDefault();
        if (e.shiftKey) {
          actions.onSwapPaneDirection(direction);
        } else {
          actions.onFocusPaneDirection(direction);
        }
      }
    };

    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [actions]);
}
