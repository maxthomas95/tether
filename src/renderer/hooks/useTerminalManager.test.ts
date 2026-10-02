// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class FakeTerminal {
    element?: HTMLDivElement;
    cols = 100;
    rows = 30;
    input?: (data: string) => void;
    options: Record<string, unknown>;
    parser = { registerOscHandler: vi.fn() };
    loadAddon = vi.fn((addon: { activate?: (terminal: FakeTerminal) => void }) => addon.activate?.(this));
    attachCustomKeyEventHandler = vi.fn();
    selection = '';
    hasSelection = vi.fn(() => this.selection !== '');
    getSelection = vi.fn(() => this.selection);
    clearSelection = vi.fn(() => { this.selection = ''; });
    paste = vi.fn();
    write = vi.fn();
    focus = vi.fn();
    refresh = vi.fn();
    scrollToBottom = vi.fn();
    dispose = vi.fn(() => this.element?.remove());
    constructor(options: Record<string, unknown>) { this.options = { ...options }; }
    onData(callback: (data: string) => void) { this.input = callback; }
    open(container: HTMLDivElement) {
      this.element = document.createElement('div');
      container.appendChild(this.element);
    }
  }
  class FakeFitAddon {
    terminal?: FakeTerminal;
    activate(terminal: FakeTerminal) { this.terminal = terminal; }
    fit = vi.fn(() => {
      const container = this.terminal?.element?.parentElement;
      if (!container || !this.terminal) return;
      this.terminal.cols = Math.max(2, Math.floor(container.clientWidth / 10));
      this.terminal.rows = Math.max(1, Math.floor(container.clientHeight / 20));
    });
  }
  class FakeSearchAddon {
    listeners = new Set<(event: { resultIndex: number; resultCount: number }) => void>();
    findNext = vi.fn(() => true);
    findPrevious = vi.fn(() => true);
    clearDecorations = vi.fn();
    onDidChangeResults = vi.fn((listener: (event: { resultIndex: number; resultCount: number }) => void) => {
      this.listeners.add(listener);
      return { dispose: vi.fn(() => this.listeners.delete(listener)) };
    });
    emit(event: { resultIndex: number; resultCount: number }) {
      for (const listener of this.listeners) listener(event);
    }
  }
  return {
    FakeTerminal,
    FakeFitAddon,
    FakeSearchAddon,
    resize: vi.fn(),
    sendInput: vi.fn(),
    setOutputMode: vi.fn().mockResolvedValue(undefined),
    clipboard: {
      writeText: vi.fn().mockResolvedValue(undefined),
      readText: vi.fn(() => 'from clipboard'),
    },
  };
});

vi.mock('@xterm/xterm', () => ({ Terminal: mocks.FakeTerminal }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: mocks.FakeFitAddon }));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: mocks.FakeSearchAddon }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));

import { useTerminalManager, type TerminalManagerAPI, type TerminalCursorStyle } from './useTerminalManager';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
let api: TerminalManagerAPI;
let frames: FrameRequestCallback[];

function Harness({ color = '#000000', cursor = 'block', scrollback = 10000, fontFamily = '' }: {
  color?: string; cursor?: TerminalCursorStyle; scrollback?: number; fontFamily?: string;
}) {
  api = useTerminalManager({ background: color }, fontFamily, cursor, true, scrollback);
  return null;
}

function render(props: Parameters<typeof Harness>[0] = {}) {
  act(() => root.render(createElement(Harness, props)));
}

function flushFrames() {
  act(() => { for (const callback of frames.splice(0)) callback(0); });
}

function pane() {
  const container = document.createElement('div');
  container.style.width = '1000px';
  container.style.height = '600px';
  Object.defineProperties(container, {
    clientWidth: { get: () => parseInt(container.style.width) },
    clientHeight: { get: () => parseInt(container.style.height) },
  });
  host.appendChild(container);
  return container;
}

function terminal(sessionId: string) {
  return api.peek(sessionId) as unknown as InstanceType<typeof mocks.FakeTerminal>;
}

function searchAddon(sessionId: string) {
  return terminal(sessionId).loadAddon.mock.calls
    .map(([addon]) => addon)
    .find(addon => addon instanceof mocks.FakeSearchAddon) as InstanceType<typeof mocks.FakeSearchAddon>;
}

beforeEach(() => {
  vi.clearAllMocks();
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  mocks.clipboard.writeText.mockResolvedValue(undefined);
  vi.stubGlobal('electronAPI', { session: mocks, clipboard: mocks.clipboard });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  render();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, 'fonts');
});

describe('terminal session lifecycle', () => {
  it('waits for fonts, ignores stale font loads, and refits only visible panes', async () => {
    const finish = new Map<string, () => void>();
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: {
        check: () => false,
        load: vi.fn((font: string) => new Promise<void>(resolve => finish.set(font, resolve))),
      },
    });
    render({ fontFamily: "'Iosevka Fixed', monospace" });
    api.attachToPane('left', 'a', pane());
    api.getOrCreate('b');
    const visible = terminal('a');
    const background = terminal('b');
    expect(visible.options.fontFamily).toBe('monospace');
    render({ fontFamily: "'IBM Plex Mono', monospace" });
    mocks.resize.mockClear();
    await act(async () => { finish.get("14px 'Iosevka Fixed', monospace")!(); });
    expect(visible.options.fontFamily).toBe('monospace');
    expect(mocks.resize).not.toHaveBeenCalled();
    await act(async () => { finish.get("14px 'IBM Plex Mono', monospace")!(); });
    for (const instance of [visible, background]) {
      expect(instance.options.fontFamily).toBe("'IBM Plex Mono', monospace");
      expect(instance.dispose).not.toHaveBeenCalled();
    }
    expect(mocks.resize.mock.calls).toEqual([['a', 100, 30]]);
  });

  it('uses the default preset when clearing a font before App updates its CSS', async () => {
    document.documentElement.style.setProperty('--font-mono-terminal', "'Iosevka Fixed', monospace");
    api.getOrCreate('a');
    render({ fontFamily: "'IBM Plex Mono', monospace" });
    await act(async () => {});
    expect(terminal('a').options.fontFamily).toBe("'IBM Plex Mono', monospace");
    render({ fontFamily: '' });
    await act(async () => {});
    expect(terminal('a').options.fontFamily).toContain("'Cascadia Code'");
    expect(terminal('a').options.fontFamily).not.toContain('Iosevka');
    document.documentElement.style.removeProperty('--font-mono-terminal');
  });

  it('restores the terminal and transport dimensions after shrinking and expanding a pane', () => {
    const container = pane();
    api.attachToPane('left', 'coder-session', container);
    flushFrames();
    container.style.width = '400px';
    container.style.height = '200px';
    api.fitPane('left');
    expect(mocks.resize).toHaveBeenLastCalledWith('coder-session', 40, 10);
    container.style.width = '1200px';
    container.style.height = '800px';
    api.fitPane('left');
    expect(terminal('coder-session')).toMatchObject({ cols: 120, rows: 40 });
    expect(mocks.resize).toHaveBeenLastCalledWith('coder-session', 120, 40);
  });

  it('keeps the last usable size while a container is hidden or detached', () => {
    const container = pane();
    api.attachToPane('left', 'a', container);
    flushFrames();
    flushFrames();
    mocks.resize.mockClear();
    container.style.width = '0px';
    container.style.height = '0px';
    api.fitPane('left');
    api.focusPane('left');
    api.setSessionFontSize('a', 20);
    expect(mocks.resize).not.toHaveBeenCalled();
    expect(terminal('a')).toMatchObject({ cols: 100, rows: 30 });
    container.style.width = '1200px';
    container.style.height = '800px';
    container.remove();
    api.fitPane('left');
    expect(mocks.resize).not.toHaveBeenCalled();
    host.appendChild(container);
    api.fitPane('left');
    expect(mocks.resize).toHaveBeenCalledExactlyOnceWith('a', 120, 40);
  });

  it('preserves raw output and scrollback when a session is backgrounded and reattached', () => {
    const raw = '\x1b[31mred\x1b[0m\r\n\x00日本語';
    api.getOrCreate('a');
    const original = terminal('a');
    api.writeData('a', raw);
    expect(original.write).toHaveBeenCalledExactlyOnceWith(raw);
    expect(original.element).toBeUndefined();

    const first = pane();
    api.attachToPane('left', 'a', first);
    flushFrames();
    api.detachPane('left');
    expect(original.element?.isConnected).toBe(false);
    expect(original.dispose).not.toHaveBeenCalled();
    api.writeData('a', 'background bytes');

    const second = pane();
    api.attachToPane('right', 'a', second, false);
    original.focus.mockClear();
    flushFrames();
    expect(terminal('a')).toBe(original);
    expect(second.contains(original.element!)).toBe(true);
    expect(original.write.mock.calls).toEqual([[raw], ['background bytes']]);
    expect(original.refresh).toHaveBeenLastCalledWith(0, 29);
    expect(original.scrollToBottom).toHaveBeenCalled();
    expect(original.focus).not.toHaveBeenCalled();
  });

  it('searches the focused pane without writing process input and keeps the addon through detach', () => {
    const first = pane();
    api.attachToPane('left', 'a', first);
    const addon = searchAddon('a');

    expect(api.findInPane('left', 'needle', { caseSensitive: true, incremental: true })).toBe(true);
    expect(addon.findNext).toHaveBeenCalledExactlyOnceWith('needle', {
      caseSensitive: true,
      wholeWord: false,
      incremental: true,
    });
    const listener = vi.fn();
    const unsubscribe = api.onFindResultsInPane('left', listener);
    addon.emit({ resultIndex: 0, resultCount: 2 });
    expect(listener).toHaveBeenCalledExactlyOnceWith({ resultIndex: 0, resultCount: 2 });
    api.findInPane('left', ' needle ');
    expect(addon.findNext).toHaveBeenLastCalledWith(' needle ', {
      caseSensitive: false,
      wholeWord: false,
      incremental: false,
    });
    expect(mocks.sendInput).not.toHaveBeenCalled();

    api.detachPane('left');
    addon.emit({ resultIndex: 1, resultCount: 2 });
    expect(listener).toHaveBeenCalledOnce();
    const second = pane();
    api.attachToPane('right', 'a', second, false);
    expect(searchAddon('a')).toBe(addon);
    expect(api.findInPane('right', 'needle', { previous: true, wholeWord: true })).toBe(true);
    expect(addon.findPrevious).toHaveBeenCalledExactlyOnceWith('needle', {
      caseSensitive: false,
      wholeWord: true,
      incremental: false,
    });

    expect(api.findInPane('right', '')).toBe(false);
    api.clearFindInPane('right');
    expect(addon.clearDecorations).toHaveBeenCalledTimes(2);
    expect(terminal('a').clearSelection).toHaveBeenCalledTimes(2);
    unsubscribe();
    addon.emit({ resultIndex: 1, resultCount: 2 });
    expect(listener).toHaveBeenCalledOnce();
  });

  it('discards delayed layout work after another session reuses the same pane container', () => {
    const container = pane();
    api.attachToPane('left', 'old', container);
    const old = terminal('old');
    api.detachPane('left');
    api.attachToPane('left', 'new', container);
    flushFrames();
    flushFrames();
    expect(old.focus).not.toHaveBeenCalled();
    expect(mocks.resize.mock.calls.map(([sessionId]) => sessionId)).toEqual(['new', 'new']);
  });

  it('writes to both visible copies and retains the surviving copy when a split closes', () => {
    api.attachToPane('left', 'a', pane());
    const first = terminal('a');
    api.attachToPane('right', 'a', pane());
    api.writeData('a', '\x1b[2J');
    expect(first.write).toHaveBeenCalledExactlyOnceWith('\x1b[2J');
    api.detachPane('left');
    expect(first.dispose).toHaveBeenCalledOnce();
    const survivor = terminal('a');
    expect(survivor).not.toBe(first);
    expect(survivor.write).toHaveBeenCalledExactlyOnceWith('\x1b[2J');
    api.detachPane('right');
    expect(terminal('a')).toBe(survivor);
    expect(survivor.dispose).not.toHaveBeenCalled();
  });

  it('disposes removed sessions and prevents their queued resize callbacks', () => {
    api.attachToPane('left', 'a', pane());
    const visible = terminal('a');
    api.getOrCreate('b');
    const background = terminal('b');
    api.remove('a');
    api.remove('b');
    flushFrames();
    expect(visible.dispose).toHaveBeenCalledOnce();
    expect(background.dispose).toHaveBeenCalledOnce();
    expect(api.peek('a')).toBeUndefined();
    expect(api.peek('b')).toBeUndefined();
    expect(mocks.resize).not.toHaveBeenCalled();
  });

  it('applies settings to visible and background terminals without recreating them', () => {
    api.attachToPane('left', 'a', pane());
    api.getOrCreate('b');
    const visible = terminal('a');
    const background = terminal('b');
    render({ color: '#ffffff', cursor: 'bar', scrollback: 2000 });
    for (const instance of [visible, background]) {
      expect(instance.options).toMatchObject({ theme: { background: '#ffffff' }, cursorStyle: 'bar', scrollback: 2000 });
      expect(instance.dispose).not.toHaveBeenCalled();
    }
    api.setSessionFontSize('a', 20);
    expect(visible.options.fontSize).toBe(20);
    expect(background.options.fontSize).toBe(14);
    expect(mocks.resize).toHaveBeenCalledWith('a', 100, 30);
  });

  it('broadcasts input only from a selected session and honors changes to targets', () => {
    for (const id of ['a', 'b', 'c']) api.getOrCreate(id);
    api.setBroadcastTargets(['a', 'b']);
    terminal('a').input?.('\x1b[13;2u');
    terminal('c').input?.('own input');
    expect(mocks.sendInput.mock.calls).toEqual([['a', '\x1b[13;2u'], ['b', '\x1b[13;2u'], ['c', 'own input']]);
    mocks.sendInput.mockClear();
    api.setBroadcastTargets([]);
    terminal('a').input?.('one');
    expect(mocks.sendInput).toHaveBeenCalledExactlyOnceWith('a', 'one');
  });
});

describe('terminal clipboard', () => {
  type KeyHandler = (e: KeyboardEvent) => boolean;

  function keyHandler(sessionId: string): KeyHandler {
    const [[handler]] = terminal(sessionId).attachCustomKeyEventHandler.mock.calls as [[KeyHandler]];
    return handler;
  }

  function press(handler: KeyHandler, type: 'keydown' | 'keyup', init: KeyboardEventInit) {
    const event = new KeyboardEvent(type, { cancelable: true, ctrlKey: true, ...init });
    return { result: handler(event), prevented: event.defaultPrevented };
  }

  it('copies the trimmed selection once per Ctrl+C press and cancels only the keydown', () => {
    api.getOrCreate('a');
    const handler = keyHandler('a');
    terminal('a').selection = 'first line   \nsecond  ';

    expect(press(handler, 'keydown', { key: 'c' })).toEqual({ result: false, prevented: true });
    expect(press(handler, 'keyup', { key: 'c' })).toEqual({ result: false, prevented: false });
    expect(mocks.clipboard.writeText).toHaveBeenCalledExactlyOnceWith('first line\nsecond');
  });

  it('passes Ctrl+C through as SIGINT when nothing is selected', () => {
    api.getOrCreate('a');
    const handler = keyHandler('a');

    expect(press(handler, 'keydown', { key: 'c' })).toEqual({ result: true, prevented: false });
    expect(mocks.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('copies on Ctrl+Shift+C keydown only, and never writes an empty selection', () => {
    api.getOrCreate('a');
    const handler = keyHandler('a');

    expect(press(handler, 'keydown', { key: 'C', shiftKey: true })).toEqual({ result: false, prevented: true });
    expect(mocks.clipboard.writeText).not.toHaveBeenCalled();

    terminal('a').selection = 'picked  ';
    expect(press(handler, 'keydown', { key: 'C', shiftKey: true }).result).toBe(false);
    expect(press(handler, 'keyup', { key: 'C', shiftKey: true }).result).toBe(false);
    expect(mocks.clipboard.writeText).toHaveBeenCalledExactlyOnceWith('picked');
  });

  it('leaves Ctrl+V to the native paste event without reading the clipboard', () => {
    api.getOrCreate('a');
    const handler = keyHandler('a');

    expect(press(handler, 'keydown', { key: 'v' })).toEqual({ result: false, prevented: false });
    expect(terminal('a').paste).not.toHaveBeenCalled();
    expect(mocks.clipboard.readText).not.toHaveBeenCalled();
  });

  it('forwards an OSC 52 write to the clipboard and consumes the sequence', () => {
    api.getOrCreate('a');
    const [[code, handler]] = terminal('a').parser.registerOscHandler.mock.calls as [[number, (data: string) => boolean]];
    expect(code).toBe(52);

    expect(handler(`c;${Buffer.from('café\nline two', 'utf8').toString('base64')}`)).toBe(true);
    expect(mocks.clipboard.writeText).toHaveBeenCalledExactlyOnceWith('café\nline two');
    expect(handler('c;?')).toBe(true);
    expect(mocks.clipboard.writeText).toHaveBeenCalledOnce();
  });

  it('swallows a failed clipboard write from every copy path', async () => {
    // A plain function, not vi.fn(): vitest's mock tracks returned promises
    // itself, which marks a rejection as handled and would hide the bug.
    const writes: string[] = [];
    vi.stubGlobal('electronAPI', {
      session: mocks,
      clipboard: { writeText: (text: string) => { writes.push(text); return Promise.reject(new Error('ipc gone')); } },
    });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      api.getOrCreate('a');
      const handler = keyHandler('a');
      terminal('a').selection = 'x';
      press(handler, 'keydown', { key: 'c' });
      press(handler, 'keydown', { key: 'C', shiftKey: true });
      const [[, osc]] = terminal('a').parser.registerOscHandler.mock.calls as [[number, (data: string) => boolean]];
      expect(osc(`c;${Buffer.from('y').toString('base64')}`)).toBe(true);
      expect(writes).toEqual(['x', 'x', 'y']);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
