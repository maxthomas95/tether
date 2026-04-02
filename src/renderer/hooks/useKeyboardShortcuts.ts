import { useEffect } from 'react';

interface ShortcutActions {
  onNewSession: () => void;
  onSwitchSession: (index: number) => void;
  onNextSession: () => void;
  onPrevSession: () => void;
  onToggleSidebar: () => void;
  onStopSession: () => void;
}

export function useKeyboardShortcuts(actions: ShortcutActions) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return;

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
    };

    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [actions]);
}
