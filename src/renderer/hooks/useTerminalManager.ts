import { useRef, useCallback, useEffect } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

interface ManagedTerminal {
  terminal: Terminal;
  fitAddon: FitAddon;
}

const TERMINAL_OPTIONS = {
  cursorBlink: true,
  fontFamily: "'Cascadia Code', 'Fira Code', Consolas, 'Courier New', monospace",
  fontSize: 14,
  theme: {
    background: '#1e1e1e',
    foreground: '#cccccc',
    cursor: '#cccccc',
    selectionBackground: '#264f78',
  },
  allowProposedApi: true,
} as const;

export function useTerminalManager() {
  const terminals = useRef(new Map<string, ManagedTerminal>());
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeIdRef = useRef<string | null>(null);

  // Get or create a Terminal instance for a session
  const getOrCreate = useCallback((sessionId: string): ManagedTerminal => {
    let managed = terminals.current.get(sessionId);
    if (!managed) {
      const terminal = new Terminal(TERMINAL_OPTIONS);
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);

      // Wire up input forwarding
      terminal.onData((data: string) => {
        window.electronAPI.session.sendInput(sessionId, data);
      });

      // Shift+Enter → send newline without submit (CSI u encoding)
      terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
        if (e.key === 'Enter' && e.shiftKey && e.type === 'keydown') {
          window.electronAPI.session.sendInput(sessionId, '\x1b[13;2u');
          return false; // Prevent default xterm handling
        }
        return true;
      });

      managed = { terminal, fitAddon };
      terminals.current.set(sessionId, managed);
    }
    return managed;
  }, []);

  // Write data to a session's terminal (works even if not attached to DOM)
  const writeData = useCallback((sessionId: string, data: string) => {
    const managed = terminals.current.get(sessionId);
    if (managed) {
      managed.terminal.write(data);
    }
  }, []);

  // Activate a session — attach its terminal to the DOM container
  const activate = useCallback((sessionId: string) => {
    const container = containerRef.current;
    if (!container) return;

    // Detach the currently active terminal
    if (activeIdRef.current && activeIdRef.current !== sessionId) {
      const prev = terminals.current.get(activeIdRef.current);
      if (prev?.terminal.element) {
        prev.terminal.element.remove();
      }
    }

    const managed = getOrCreate(sessionId);
    activeIdRef.current = sessionId;

    // Only open if not already attached somewhere
    if (!managed.terminal.element) {
      managed.terminal.open(container);
    } else {
      container.appendChild(managed.terminal.element);
    }

    // Fit after a frame so container has dimensions
    requestAnimationFrame(() => {
      try {
        managed.fitAddon.fit();
        window.electronAPI.session.resize(
          sessionId,
          managed.terminal.cols,
          managed.terminal.rows,
        );
      } catch {
        // ignore
      }
      managed.terminal.focus();
    });
  }, [getOrCreate]);

  // Remove a session's terminal
  const remove = useCallback((sessionId: string) => {
    const managed = terminals.current.get(sessionId);
    if (managed) {
      managed.terminal.dispose();
      terminals.current.delete(sessionId);
      if (activeIdRef.current === sessionId) {
        activeIdRef.current = null;
      }
    }
  }, []);

  // Fit the active terminal (call on resize)
  const fitActive = useCallback(() => {
    if (!activeIdRef.current) return;
    const managed = terminals.current.get(activeIdRef.current);
    if (managed) {
      try {
        managed.fitAddon.fit();
        window.electronAPI.session.resize(
          activeIdRef.current,
          managed.terminal.cols,
          managed.terminal.rows,
        );
      } catch {
        // ignore
      }
    }
  }, []);

  // Cleanup all terminals on unmount
  useEffect(() => {
    return () => {
      for (const managed of terminals.current.values()) {
        managed.terminal.dispose();
      }
      terminals.current.clear();
    };
  }, []);

  return {
    containerRef,
    getOrCreate,
    writeData,
    activate,
    remove,
    fitActive,
  };
}
