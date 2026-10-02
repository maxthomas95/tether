// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalManagerAPI } from '../hooks/useTerminalManager';
import { TerminalPane } from './TerminalPane';

vi.mock('./PaneStatusStrip', () => ({ PaneStatusStrip: () => null }));

let root: Root;
let host: HTMLDivElement;
let manager: TerminalManagerAPI;
let frames: Map<number, FrameRequestCallback>;
let observers: FakeResizeObserver[];

class FakeResizeObserver {
  observe = vi.fn();
  disconnect = vi.fn();
  constructor(readonly callback: ResizeObserverCallback) { observers.push(this); }
  notify() { this.callback([], this as unknown as ResizeObserver); }
}

function render(sessionId: string | null, overrides: Partial<ComponentProps<typeof TerminalPane>> = {}) {
  const session = sessionId ? {
    id: sessionId, label: 'Test session', state: 'running' as const, workingDir: 'repo', createdAt: 0, updatedAt: 0,
  } : undefined;
  const props: ComponentProps<typeof TerminalPane> = {
    paneId: 'pane', sessionId, session, isMaximized: false,
    onChooseSession: vi.fn(), isFocused: true, canvas: true, isDragging: false,
    draggingPaneId: null, onDragStateChange: vi.fn(), layoutDispatch: vi.fn(),
    termManager: manager, enablePaneSplitting: false, currentLeafCount: 1,
    maxPanes: 4, defaultFontSize: 14, onFontSizeDelta: vi.fn(),
    isBroadcastTarget: false, isBroadcastActive: false, onToggleBroadcastTarget: vi.fn(),
    isSearchOpen: false, searchFocusRequest: 0, onOpenSearch: vi.fn(), onCloseSearch: vi.fn(),
    ...overrides,
  };
  act(() => root.render(createElement(TerminalPane, props)));
}

function flushFrames() {
  const pending = [...frames.values()];
  frames.clear();
  act(() => pending.forEach(callback => callback(0)));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  frames = new Map();
  observers = [];
  let nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('electronAPI', { homeDir: 'home' });
  manager = {
    getOrCreate: vi.fn(), peek: vi.fn(), writeData: vi.fn(), attachToPane: vi.fn(),
    detachPane: vi.fn(), fitPane: vi.fn(), focusPane: vi.fn(), findInPane: vi.fn(),
    clearFindInPane: vi.fn(), onFindResultsInPane: vi.fn(() => vi.fn()), setSessionFontSize: vi.fn(),
    setBroadcastTargets: vi.fn(), remove: vi.fn(),
  };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('terminal pane resizing', () => {
  it('observes the terminal after an empty slot receives a session', () => {
    render(null);
    expect(observers).toHaveLength(0);
    render('coder-session');
    expect(observers).toHaveLength(1);
    expect(observers[0].observe).toHaveBeenCalledWith(host.querySelector('.terminal-pane-xterm'));
    observers[0].notify();
    flushFrames();
    expect(manager.fitPane).toHaveBeenCalledWith('pane');
  });

  it('coalesces resize bursts and fits again after the layout settles', () => {
    render('coder-session');
    flushFrames();
    vi.mocked(manager.fitPane).mockClear();
    observers[0].notify();
    observers[0].notify();
    window.dispatchEvent(new Event('resize'));
    flushFrames();
    expect(manager.fitPane).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(200));
    flushFrames();
    expect(manager.fitPane).toHaveBeenCalledTimes(2);
  });

  it('opens search from the header and closes it by clearing and refocusing the pane', () => {
    const onOpenSearch = vi.fn();
    const onCloseSearch = vi.fn();
    const layoutDispatch = vi.fn();
    render('session-a', { onOpenSearch, layoutDispatch });

    const searchButton = host.querySelector<HTMLButtonElement>('[aria-label="Find in terminal"]')!;
    act(() => searchButton.click());
    expect(layoutDispatch).toHaveBeenCalledWith({ type: 'SET_FOCUS', paneId: 'pane' });
    expect(onOpenSearch).toHaveBeenCalledExactlyOnceWith('pane');

    render('session-a', { isSearchOpen: true, onCloseSearch });
    const closeSearch = host.querySelector<HTMLButtonElement>('[aria-label="Close terminal search"]')!;
    act(() => closeSearch.click());
    expect(manager.clearFindInPane).toHaveBeenCalledWith('pane');
    expect(onCloseSearch).toHaveBeenCalledExactlyOnceWith('pane');
    flushFrames();
    expect(manager.focusPane).toHaveBeenLastCalledWith('pane');
  });

  it('cancels pending fits and observes the new container when a slot is reused', () => {
    render('old-session');
    flushFrames();
    vi.mocked(manager.fitPane).mockClear();
    const oldObserver = observers[0];
    oldObserver.notify();
    window.dispatchEvent(new Event('resize'));
    render(null);
    expect(oldObserver.disconnect).toHaveBeenCalledOnce();
    flushFrames();
    act(() => vi.advanceTimersByTime(200));
    flushFrames();
    expect(manager.fitPane).not.toHaveBeenCalled();
    render('new-session');
    expect(observers).toHaveLength(2);
    expect(observers[1].observe).toHaveBeenCalledWith(host.querySelector('.terminal-pane-xterm'));
    observers[1].notify();
    flushFrames();
    expect(manager.fitPane).toHaveBeenCalledWith('pane');
  });
});
