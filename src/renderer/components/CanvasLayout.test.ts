// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasState } from '../lib/canvas-layout';
import { CanvasLayout } from './CanvasLayout';

const paneProps: Array<Record<string, unknown>> = [];
vi.mock('./TerminalPane', () => ({
  TerminalPane: (props: Record<string, unknown>) => {
    paneProps.push(props);
    return createElement('div', { 'data-pane-id': props.paneId as string });
  },
}));

class FakeResizeObserver {
  observe = vi.fn();
  disconnect = vi.fn();
  constructor(readonly callback: ResizeObserverCallback) {}
}

let root: Root;
let host: HTMLDivElement;

const termManager = {
  getOrCreate: vi.fn(), peek: vi.fn(), writeData: vi.fn(), attachToPane: vi.fn(),
  detachPane: vi.fn(), fitPane: vi.fn(), focusPane: vi.fn(), findInPane: vi.fn(),
  clearFindInPane: vi.fn(), onFindResultsInPane: vi.fn(), setSessionFontSize: vi.fn(),
  setBroadcastTargets: vi.fn(), remove: vi.fn(),
};

beforeEach(() => {
  paneProps.length = 0;
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('CanvasLayout terminal search forwarding', () => {
  it('passes search state to visible canvas panes', () => {
    const state: CanvasState = {
      panels: [{ id: 'canvas-pane', sessionId: 'session-a', x: 0, y: 0, width: 500, height: 360 }],
      viewport: { x: 0, y: 0, width: 800, height: 600 },
      focusedPaneId: 'canvas-pane',
      maximizedPaneId: null,
    };

    act(() => root.render(createElement(CanvasLayout, {
      state,
      dispatch: vi.fn(),
      termManager,
      sessions: [{ id: 'session-a', label: 'Canvas', state: 'running', workingDir: '', createdAt: 0, updatedAt: 0 }],
      environments: [{ id: 'local', name: 'Local', type: 'local' }],
      defaultFontSize: 14,
      onFontSizeDelta: vi.fn(),
      onRestartInPane: vi.fn(),
      onChooseSession: vi.fn(),
      onDropComplete: vi.fn(),
      searchPaneId: 'canvas-pane',
      searchFocusRequest: 4,
      onOpenTerminalSearch: vi.fn(),
      onCloseTerminalSearch: vi.fn(),
    })));

    expect(paneProps[0]).toMatchObject({
      paneId: 'canvas-pane',
      isSearchOpen: true,
      searchFocusRequest: 4,
      isFocused: true,
      canvas: true,
    });

    paneProps.length = 0;
    act(() => root.render(createElement(CanvasLayout, {
      state,
      dispatch: vi.fn(),
      termManager,
      sessions: [{ id: 'session-a', label: 'Canvas', state: 'running', workingDir: '', createdAt: 0, updatedAt: 0 }],
      environments: [{ id: 'local', name: 'Local', type: 'local' }],
      defaultFontSize: 14,
      onFontSizeDelta: vi.fn(),
      onRestartInPane: vi.fn(),
      onChooseSession: vi.fn(),
      onDropComplete: vi.fn(),
      searchPaneId: 'other-pane',
      searchFocusRequest: 4,
      onOpenTerminalSearch: vi.fn(),
      onCloseTerminalSearch: vi.fn(),
    })));
    expect(paneProps[0]).toMatchObject({ isSearchOpen: false, searchFocusRequest: 0 });
  });
});
