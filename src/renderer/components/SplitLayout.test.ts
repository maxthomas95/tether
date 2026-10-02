// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LayoutNode } from '../../shared/layout-types';
import { SplitLayout } from './SplitLayout';

const paneProps: Array<Record<string, unknown>> = [];
vi.mock('./TerminalPane', () => ({
  TerminalPane: (props: Record<string, unknown>) => {
    paneProps.push(props);
    return createElement('div', { 'data-pane-id': props.paneId as string });
  },
}));

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
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('SplitLayout terminal search forwarding', () => {
  it('marks only the searched leaf open and forwards focus requests through recursive splits', () => {
    const node: LayoutNode = {
      id: 'root', type: 'split', direction: 'horizontal', children: [
        { id: 'left', type: 'leaf', sessionId: 'session-left' },
        { id: 'right', type: 'leaf', sessionId: 'session-right' },
      ],
    };
    act(() => root.render(createElement(SplitLayout, {
      node,
      layoutDispatch: vi.fn(),
      termManager,
      sessions: [
        { id: 'session-left', label: 'Left', state: 'running', workingDir: '', createdAt: 0, updatedAt: 0 },
        { id: 'session-right', label: 'Right', state: 'running', workingDir: '', createdAt: 0, updatedAt: 0 },
      ],
      environments: [{ id: 'local', name: 'Local', type: 'local' }],
      onChooseSession: vi.fn(),
      isDragging: false,
      draggingPaneId: null,
      onDragStateChange: vi.fn(),
      focusedPaneId: 'right',
      maximizedPaneId: null,
      enablePaneSplitting: true,
      currentLeafCount: 2,
      maxPanes: 4,
      defaultFontSize: 14,
      onFontSizeDelta: vi.fn(),
      broadcastPaneIds: new Set(['right']),
      broadcastActive: true,
      onToggleBroadcastTarget: vi.fn(),
      searchPaneId: 'right',
      searchFocusRequest: 7,
      onOpenTerminalSearch: vi.fn(),
      onCloseTerminalSearch: vi.fn(),
      onRestartInPane: vi.fn(),
    })));

    const left = paneProps.find(props => props.paneId === 'left');
    const right = paneProps.find(props => props.paneId === 'right');
    expect(left).toMatchObject({ isSearchOpen: false, searchFocusRequest: 0, isBroadcastTarget: false });
    expect(right).toMatchObject({ isSearchOpen: true, searchFocusRequest: 7, isBroadcastTarget: true, isFocused: true });
  });
});
