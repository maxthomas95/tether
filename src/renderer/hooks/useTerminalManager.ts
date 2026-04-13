import { useRef, useCallback, useEffect, useMemo } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { PaneId } from '../../shared/layout-types';

interface ManagedTerminal {
  terminal: Terminal;
  fitAddon: FitAddon;
}

interface PaneEntry {
  sessionId: string;
  terminal: Terminal;
  fitAddon: FitAddon;
  container: HTMLDivElement | null;
}

const BASE_TERMINAL_OPTIONS = {
  cursorBlink: true,
  fontFamily: "'Cascadia Code', 'Fira Code', Consolas, 'Courier New', monospace",
  fontSize: 14,
  allowProposedApi: true,
} as const;

export interface TerminalManagerAPI {
  getOrCreate: (sessionId: string) => ManagedTerminal;
  writeData: (sessionId: string, data: string) => void;
  attachToPane: (paneId: PaneId, sessionId: string | null, container: HTMLDivElement) => void;
  detachPane: (paneId: PaneId) => void;
  fitPane: (paneId: PaneId) => void;
  focusPane: (paneId: PaneId) => void;
  remove: (sessionId: string) => void;
}

export function useTerminalManager(xtermTheme?: ITheme): TerminalManagerAPI {
  const panes = useRef(new Map<PaneId, PaneEntry>());
  const backgroundTerminals = useRef(new Map<string, ManagedTerminal>());
  const themeRef = useRef<ITheme | undefined>(xtermTheme);

  // Update theme on all existing terminals when it changes
  useEffect(() => {
    themeRef.current = xtermTheme;
    if (!xtermTheme) return;
    for (const entry of panes.current.values()) {
      entry.terminal.options.theme = xtermTheme;
    }
    for (const managed of backgroundTerminals.current.values()) {
      managed.terminal.options.theme = xtermTheme;
    }
  }, [xtermTheme]);

  const createTerminal = useCallback((sessionId: string): ManagedTerminal => {
    const terminal = new Terminal({ ...BASE_TERMINAL_OPTIONS, theme: themeRef.current });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    // Wire up input forwarding
    terminal.onData((data: string) => {
      window.electronAPI.session.sendInput(sessionId, data);
    });

    terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;

      // Shift+Enter → newline without submit
      if (e.key === 'Enter' && e.shiftKey) {
        if (e.type === 'keydown') {
          window.electronAPI.session.sendInput(sessionId, '\x1b[13;2u');
        }
        return false;
      }

      // Ctrl+C with selection → copy to clipboard
      if (ctrl && e.key === 'c' && terminal.hasSelection()) {
        window.electronAPI.clipboard.writeText(terminal.getSelection());
        return false;
      }

      // Ctrl+V → paste from clipboard
      if (ctrl && e.key === 'v' && e.type === 'keydown') {
        const text = window.electronAPI.clipboard.readText();
        if (text) window.electronAPI.session.sendInput(sessionId, text);
        return false;
      }

      // Ctrl+Shift+C → always copy
      if (ctrl && e.shiftKey && e.key === 'C') {
        window.electronAPI.clipboard.writeText(terminal.getSelection());
        return false;
      }

      return true;
    });

    return { terminal, fitAddon };
  }, []);

  // Get or create a background terminal for sessions not in any visible pane
  const getOrCreate = useCallback((sessionId: string): ManagedTerminal => {
    let managed = backgroundTerminals.current.get(sessionId);
    if (!managed) {
      managed = createTerminal(sessionId);
      backgroundTerminals.current.set(sessionId, managed);
    }
    return managed;
  }, [createTerminal]);

  // Write data to ALL panes showing this session + background terminal
  const writeData = useCallback((sessionId: string, data: string) => {
    // Write to background terminal if exists
    const bg = backgroundTerminals.current.get(sessionId);
    if (bg) {
      bg.terminal.write(data);
    }

    // Write to all panes showing this session
    for (const entry of panes.current.values()) {
      if (entry.sessionId === sessionId) {
        entry.terminal.write(data);
      }
    }
  }, []);

  // Attach a terminal to a pane container
  const attachToPane = useCallback((paneId: PaneId, sessionId: string | null, container: HTMLDivElement) => {
    if (sessionId === null) return;

    let terminal: Terminal;
    let fitAddon: FitAddon;

    // Reuse background terminal if it exists — it has the scrollback buffer
    const bg = backgroundTerminals.current.get(sessionId);
    let wasBackground = false;
    if (bg) {
      terminal = bg.terminal;
      fitAddon = bg.fitAddon;
      backgroundTerminals.current.delete(sessionId);
      wasBackground = true;

      if (!terminal.element) {
        terminal.open(container);
      } else {
        container.appendChild(terminal.element);
      }
    } else {
      // No background terminal — create fresh
      const managed = createTerminal(sessionId);
      terminal = managed.terminal;
      fitAddon = managed.fitAddon;
      terminal.open(container);
    }

    panes.current.set(paneId, { sessionId, terminal, fitAddon, container });

    // Fit after the layout has settled — a single rAF can be too early for
    // flex containers that haven't received their final dimensions yet.
    const doFit = () => {
      try {
        fitAddon.fit();
        window.electronAPI.session.resize(sessionId, terminal.cols, terminal.rows);
      } catch {
        // ignore
      }
    };
    requestAnimationFrame(() => {
      doFit();
      if (wasBackground) {
        // After DOM reattachment, xterm.js's renderer and viewport may be
        // stale — the renderer skips paints while the element is detached,
        // and the viewport's scroll area can desync. Force a full repaint
        // and scroll-area recalculation so scrollback works again.
        terminal.refresh(0, terminal.rows - 1);
        terminal.scrollToBottom();
      }
      terminal.focus();
      // Second fit after another frame to catch late layout shifts
      requestAnimationFrame(doFit);
    });
  }, [createTerminal]);

  // Detach a pane's terminal
  const detachPane = useCallback((paneId: PaneId) => {
    const entry = panes.current.get(paneId);
    if (!entry) return;

    const { sessionId, terminal, fitAddon } = entry;

    // Check if any OTHER pane shows this session
    let otherPaneExists = false;
    for (const [id, e] of panes.current.entries()) {
      if (id !== paneId && e.sessionId === sessionId) {
        otherPaneExists = true;
        break;
      }
    }

    // If no other pane shows this session, keep the existing terminal as a
    // background terminal so the scrollback buffer is preserved.
    if (!otherPaneExists && !backgroundTerminals.current.has(sessionId)) {
      // Detach from the DOM without disposing — the buffer stays intact
      if (terminal.element?.parentElement) {
        terminal.element.parentElement.removeChild(terminal.element);
      }
      backgroundTerminals.current.set(sessionId, { terminal, fitAddon });
    } else {
      terminal.dispose();
    }

    panes.current.delete(paneId);
  }, []);

  // Fit a specific pane and send resize IPC
  const fitPane = useCallback((paneId: PaneId) => {
    const entry = panes.current.get(paneId);
    if (!entry) return;
    try {
      entry.fitAddon.fit();
      window.electronAPI.session.resize(entry.sessionId, entry.terminal.cols, entry.terminal.rows);
    } catch {
      // ignore
    }
  }, []);

  // Focus a specific pane's terminal
  const focusPane = useCallback((paneId: PaneId) => {
    const entry = panes.current.get(paneId);
    if (!entry) return;
    entry.terminal.focus();
    try {
      entry.fitAddon.fit();
      window.electronAPI.session.resize(entry.sessionId, entry.terminal.cols, entry.terminal.rows);
    } catch {
      // ignore
    }
  }, []);

  // Remove ALL terminals for a session (panes + background)
  const remove = useCallback((sessionId: string) => {
    // Remove from panes
    for (const [paneId, entry] of panes.current.entries()) {
      if (entry.sessionId === sessionId) {
        entry.terminal.dispose();
        panes.current.delete(paneId);
      }
    }
    // Remove background terminal
    const bg = backgroundTerminals.current.get(sessionId);
    if (bg) {
      bg.terminal.dispose();
      backgroundTerminals.current.delete(sessionId);
    }
  }, []);

  // Cleanup all terminals on unmount
  useEffect(() => {
    return () => {
      for (const entry of panes.current.values()) {
        entry.terminal.dispose();
      }
      panes.current.clear();
      for (const managed of backgroundTerminals.current.values()) {
        managed.terminal.dispose();
      }
      backgroundTerminals.current.clear();
    };
  }, []);

  return useMemo<TerminalManagerAPI>(() => ({
    getOrCreate,
    writeData,
    attachToPane,
    detachPane,
    fitPane,
    focusPane,
    remove,
  }), [getOrCreate, writeData, attachToPane, detachPane, fitPane, focusPane, remove]);
}
