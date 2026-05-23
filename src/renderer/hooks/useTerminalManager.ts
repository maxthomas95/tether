import { useRef, useCallback, useEffect, useMemo } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { PaneId } from '../../shared/layout-types';

interface ManagedTerminal {
  terminal: Terminal;
  fitAddon: FitAddon;
  linksAddon: WebLinksAddon;
}

interface PaneEntry {
  sessionId: string;
  terminal: Terminal;
  fitAddon: FitAddon;
  linksAddon: WebLinksAddon;
  container: HTMLDivElement | null;
}

const FALLBACK_TERMINAL_FONT =
  "'JetBrains Mono Variable', 'JetBrains Mono', 'Cascadia Code', 'Fira Code', Consolas, 'Courier New', monospace";

/**
 * Read the terminal font stack from the `--font-mono-terminal` CSS variable
 * (defined in tokens.css). This is the seam that lets a future "Terminal font
 * family" user setting override only the terminal pane — `--font-mono-ui`
 * stays locked to the Tether identity face.
 */
function getTerminalFontFamily(): string {
  if (typeof window === 'undefined' || !document.documentElement) {
    return FALLBACK_TERMINAL_FONT;
  }
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue('--font-mono-terminal')
    .trim();
  return value || FALLBACK_TERMINAL_FONT;
}

export type TerminalCursorStyle = 'block' | 'underline' | 'bar';

const BASE_TERMINAL_OPTIONS = {
  fontSize: 14,
  allowProposedApi: true,
} as const;

function trimSelectionTrailingSpaces(text: string): string {
  return text.replace(/[^\S\n]+$/gm, '');
}

/**
 * Scrollback buffer size constants. xterm.js's built-in default is 1000 lines,
 * which agent sessions blow past almost instantly. Tether's default is 10k.
 * The setting is exposed in Settings → Terminal and persisted via
 * `config.set('terminalScrollback', String(n))`.
 */
export const DEFAULT_SCROLLBACK = 10000;
export const MIN_SCROLLBACK = 100;
export const MAX_SCROLLBACK = 100000;

export function clampScrollback(value: number | undefined | null): number {
  if (value === undefined || value === null || !Number.isFinite(value)) {
    return DEFAULT_SCROLLBACK;
  }
  return Math.max(MIN_SCROLLBACK, Math.min(MAX_SCROLLBACK, Math.floor(value)));
}

export interface TerminalManagerAPI {
  getOrCreate: (sessionId: string) => ManagedTerminal;
  writeData: (sessionId: string, data: string) => void;
  attachToPane: (paneId: PaneId, sessionId: string | null, container: HTMLDivElement) => void;
  detachPane: (paneId: PaneId) => void;
  fitPane: (paneId: PaneId) => void;
  focusPane: (paneId: PaneId) => void;
  setSessionFontSize: (sessionId: string, fontSize: number) => void;
  setBroadcastTargets: (sessionIds: readonly string[]) => void;
  remove: (sessionId: string) => void;
}

export function useTerminalManager(
  xtermTheme?: ITheme,
  fontFamilyTrigger?: string,
  cursorStyle: TerminalCursorStyle = 'block',
  cursorBlink: boolean = true,
  scrollback?: number,
): TerminalManagerAPI {
  const panes = useRef(new Map<PaneId, PaneEntry>());
  const backgroundTerminals = useRef(new Map<string, ManagedTerminal>());
  const broadcastTargets = useRef(new Set<string>());
  const themeRef = useRef<ITheme | undefined>(xtermTheme);
  const cursorStyleRef = useRef<TerminalCursorStyle>(cursorStyle);
  const cursorBlinkRef = useRef<boolean>(cursorBlink);
  const scrollbackRef = useRef<number>(clampScrollback(scrollback));

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

  // Re-read the `--font-mono-terminal` CSS var when the user changes the
  // terminal font setting. The trigger value isn't used directly — App.tsx
  // applies the value to the CSS var, and we resolve through getComputedStyle
  // so the same path runs whether the user picks a preset or clears it.
  useEffect(() => {
    const family = getTerminalFontFamily();
    for (const entry of panes.current.values()) {
      entry.terminal.options.fontFamily = family;
    }
    for (const managed of backgroundTerminals.current.values()) {
      managed.terminal.options.fontFamily = family;
    }
  }, [fontFamilyTrigger]);

  // Propagate cursor shape + blink to every live terminal when the user
  // changes the setting. Mirrors the theme/font-family pattern above.
  useEffect(() => {
    cursorStyleRef.current = cursorStyle;
    cursorBlinkRef.current = cursorBlink;
    for (const entry of panes.current.values()) {
      entry.terminal.options.cursorStyle = cursorStyle;
      entry.terminal.options.cursorBlink = cursorBlink;
    }
    for (const managed of backgroundTerminals.current.values()) {
      managed.terminal.options.cursorStyle = cursorStyle;
      managed.terminal.options.cursorBlink = cursorBlink;
    }
  }, [cursorStyle, cursorBlink]);

  // Push scrollback changes to all live terminals so the setting takes effect
  // without requiring the user to recreate panes. xterm.js trims the existing
  // buffer if you shrink the value, so we clamp before assignment.
  useEffect(() => {
    const next = clampScrollback(scrollback);
    scrollbackRef.current = next;
    for (const entry of panes.current.values()) {
      entry.terminal.options.scrollback = next;
    }
    for (const managed of backgroundTerminals.current.values()) {
      managed.terminal.options.scrollback = next;
    }
  }, [scrollback]);

  const sendInput = useCallback((sessionId: string, data: string) => {
    const targets = broadcastTargets.current;
    if (targets.size > 1 && targets.has(sessionId)) {
      for (const targetId of targets) {
        window.electronAPI.session.sendInput(targetId, data);
      }
      return;
    }

    window.electronAPI.session.sendInput(sessionId, data);
  }, []);

  const setBroadcastTargets = useCallback((sessionIds: readonly string[]) => {
    broadcastTargets.current = new Set(sessionIds);
  }, []);

  const createTerminal = useCallback((sessionId: string): ManagedTerminal => {
    const terminal = new Terminal({
      ...BASE_TERMINAL_OPTIONS,
      cursorStyle: cursorStyleRef.current,
      cursorBlink: cursorBlinkRef.current,
      fontFamily: getTerminalFontFamily(),
      scrollback: scrollbackRef.current,
      theme: themeRef.current,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    const linksAddon = new WebLinksAddon((event, uri) => {
      if (!event.ctrlKey && !event.metaKey) return;
      window.electronAPI.shell.openExternal(uri);
    });
    terminal.loadAddon(linksAddon);

    // Wire up input forwarding
    terminal.onData((data: string) => {
      sendInput(sessionId, data);
    });

    terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;

      // Shift+Enter → newline without submit
      if (e.key === 'Enter' && e.shiftKey) {
        if (e.type === 'keydown') {
          sendInput(sessionId, '\x1b[13;2u');
        }
        return false;
      }

      // Ctrl+C with selection → copy to clipboard
      if (ctrl && e.key === 'c' && terminal.hasSelection()) {
        window.electronAPI.clipboard.writeText(trimSelectionTrailingSpaces(terminal.getSelection()));
        return false;
      }

      // Ctrl+V → paste from clipboard
      if (ctrl && e.key === 'v' && e.type === 'keydown') {
        const text = window.electronAPI.clipboard.readText();
        if (text) sendInput(sessionId, text);
        return false;
      }

      // Ctrl+Shift+C → always copy
      if (ctrl && e.shiftKey && e.key === 'C') {
        window.electronAPI.clipboard.writeText(trimSelectionTrailingSpaces(terminal.getSelection()));
        return false;
      }

      return true;
    });

    return { terminal, fitAddon, linksAddon };
  }, [sendInput]);

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
    let linksAddon: WebLinksAddon;

    // Reuse background terminal if it exists — it has the scrollback buffer
    const bg = backgroundTerminals.current.get(sessionId);
    let wasBackground = false;
    if (bg) {
      terminal = bg.terminal;
      fitAddon = bg.fitAddon;
      linksAddon = bg.linksAddon;
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
      linksAddon = managed.linksAddon;
      terminal.open(container);
    }

    panes.current.set(paneId, { sessionId, terminal, fitAddon, linksAddon, container });

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

    const { sessionId, terminal, fitAddon, linksAddon } = entry;

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
      backgroundTerminals.current.set(sessionId, { terminal, fitAddon, linksAddon });
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

  // Apply a font size to all terminals (panes + background) for a session,
  // then refit visible panes so the dimensions stay accurate.
  const setSessionFontSize = useCallback((sessionId: string, fontSize: number) => {
    const bg = backgroundTerminals.current.get(sessionId);
    if (bg && bg.terminal.options.fontSize !== fontSize) {
      bg.terminal.options.fontSize = fontSize;
    }
    for (const entry of panes.current.values()) {
      if (entry.sessionId !== sessionId) continue;
      if (entry.terminal.options.fontSize === fontSize) continue;
      entry.terminal.options.fontSize = fontSize;
      try {
        entry.fitAddon.fit();
        window.electronAPI.session.resize(sessionId, entry.terminal.cols, entry.terminal.rows);
      } catch {
        // ignore
      }
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
    setSessionFontSize,
    setBroadcastTargets,
    remove,
  }), [getOrCreate, writeData, attachToPane, detachPane, fitPane, focusPane, setSessionFontSize, setBroadcastTargets, remove]);
}
