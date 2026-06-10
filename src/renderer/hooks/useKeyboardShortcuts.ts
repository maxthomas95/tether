import { useEffect, useMemo } from 'react';
import {
  parseKeyEvent,
  ALL_ACTIONS,
  type Chord,
  type KeybindingAction,
} from '../../shared/keybindings';

export type PaneDirection = 'left' | 'right' | 'up' | 'down';

export interface ShortcutActions {
  onNewSession: () => void;
  onOpenSearch: () => void;
  onSwitchSession: (index: number) => void;
  onNextSession: () => void;
  onPrevSession: () => void;
  onToggleSidebar: () => void;
  onStopSession: () => void;
  onOpenSettings: () => void;
  onShowShortcuts: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onFocusPaneDirection: (direction: PaneDirection) => void;
  onSwapPaneDirection: (direction: PaneDirection) => void;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.classList.contains('xterm-helper-textarea')) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function dispatch(action: KeybindingAction, actions: ShortcutActions): void {
  switch (action) {
    case 'session.new': actions.onNewSession(); return;
    case 'session.stop': actions.onStopSession(); return;
    case 'search.open': actions.onOpenSearch(); return;
    case 'sidebar.toggle': actions.onToggleSidebar(); return;
    case 'settings.open': actions.onOpenSettings(); return;
    case 'shortcuts.show': actions.onShowShortcuts(); return;
    case 'session.next': actions.onNextSession(); return;
    case 'session.prev': actions.onPrevSession(); return;
    case 'session.switch.1': actions.onSwitchSession(0); return;
    case 'session.switch.2': actions.onSwitchSession(1); return;
    case 'session.switch.3': actions.onSwitchSession(2); return;
    case 'session.switch.4': actions.onSwitchSession(3); return;
    case 'session.switch.5': actions.onSwitchSession(4); return;
    case 'session.switch.6': actions.onSwitchSession(5); return;
    case 'session.switch.7': actions.onSwitchSession(6); return;
    case 'session.switch.8': actions.onSwitchSession(7); return;
    case 'session.switch.9': actions.onSwitchSession(8); return;
    case 'zoom.in': actions.onZoomIn(); return;
    case 'zoom.out': actions.onZoomOut(); return;
    case 'zoom.reset': actions.onZoomReset(); return;
    case 'pane.focus.left': actions.onFocusPaneDirection('left'); return;
    case 'pane.focus.right': actions.onFocusPaneDirection('right'); return;
    case 'pane.focus.up': actions.onFocusPaneDirection('up'); return;
    case 'pane.focus.down': actions.onFocusPaneDirection('down'); return;
    case 'pane.swap.left': actions.onSwapPaneDirection('left'); return;
    case 'pane.swap.right': actions.onSwapPaneDirection('right'); return;
    case 'pane.swap.up': actions.onSwapPaneDirection('up'); return;
    case 'pane.swap.down': actions.onSwapPaneDirection('down'); return;
  }
}

export function useKeyboardShortcuts(
  actions: ShortcutActions,
  bindings: Record<KeybindingAction, Chord | null>,
) {
  const chordLookup = useMemo(() => {
    const map = new Map<Chord, KeybindingAction>();
    for (const action of ALL_ACTIONS) {
      const chord = bindings[action];
      if (!chord) continue;
      map.set(chord.toLowerCase(), action);
    }
    return map;
  }, [bindings]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const chord = parseKeyEvent(e);
      if (!chord) return;
      const action = chordLookup.get(chord);
      if (!action) return;
      // Arrow-key chords must not hijack native arrow behavior in
      // non-xterm editable fields (inline rename, dialog inputs).
      if (chord.includes('arrow') && isEditableTarget(e.target)) return;
      e.preventDefault();
      dispatch(action, actions);
    };

    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [actions, chordLookup]);
}
