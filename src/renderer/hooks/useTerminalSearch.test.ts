// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalSearch, type TerminalSearchState } from './useTerminalSearch';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
let api: TerminalSearchState;
let clearFindInPane: ReturnType<typeof vi.fn>;
let focusPaneForSearch: ReturnType<typeof vi.fn>;

interface HarnessProps {
  focusedPaneId: string | null;
  modalOpen?: boolean;
  visiblePaneIds: ReadonlySet<string>;
}

function Harness({ focusedPaneId, modalOpen = false, visiblePaneIds }: HarnessProps) {
  api = useTerminalSearch({ focusedPaneId, modalOpen, visiblePaneIds, clearFindInPane, focusPaneForSearch });
  return null;
}

function render(props: HarnessProps) {
  act(() => root.render(createElement(Harness, props)));
}

beforeEach(() => {
  clearFindInPane = vi.fn();
  focusPaneForSearch = vi.fn();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('useTerminalSearch', () => {
  it('opens search on the focused pane and repeats focus requests for the same pane', () => {
    render({ focusedPaneId: 'left', visiblePaneIds: new Set(['left']) });

    act(() => api.openSearch());
    expect(api.searchPaneId).toBe('left');
    expect(api.searchFocusRequest).toBe(1);
    expect(focusPaneForSearch).toHaveBeenCalledExactlyOnceWith('left');

    act(() => api.openSearch('left'));
    expect(api.searchPaneId).toBe('left');
    expect(api.searchFocusRequest).toBe(2);
    expect(clearFindInPane).not.toHaveBeenCalled();
  });

  it('does not open search behind a modal or without a target pane', () => {
    render({ focusedPaneId: 'left', modalOpen: true, visiblePaneIds: new Set(['left']) });
    act(() => api.openSearch());
    expect(api.searchPaneId).toBeNull();
    expect(api.searchFocusRequest).toBe(0);

    render({ focusedPaneId: null, visiblePaneIds: new Set(['left']) });
    act(() => api.openSearch());
    expect(api.searchPaneId).toBeNull();
    expect(focusPaneForSearch).not.toHaveBeenCalled();
  });

  it('clears the previous pane when search moves to another pane', () => {
    render({ focusedPaneId: 'left', visiblePaneIds: new Set(['left', 'right']) });
    act(() => api.openSearch());
    render({ focusedPaneId: 'right', visiblePaneIds: new Set(['left', 'right']) });
    act(() => api.openSearch());

    expect(api.searchPaneId).toBe('right');
    expect(clearFindInPane).toHaveBeenCalledExactlyOnceWith('left');
    expect(focusPaneForSearch).toHaveBeenLastCalledWith('right');
  });

  it('closes only the active search pane', () => {
    render({ focusedPaneId: 'left', visiblePaneIds: new Set(['left', 'right']) });
    act(() => api.openSearch('left'));
    act(() => api.closeSearch('right'));
    expect(api.searchPaneId).toBe('left');

    act(() => api.closeSearch('left'));
    expect(api.searchPaneId).toBeNull();
  });

  it('clears search when the active pane is removed from the visible set', () => {
    const visible = new Set(['left', 'right']);
    render({ focusedPaneId: 'left', visiblePaneIds: visible });
    act(() => api.openSearch('right'));

    render({ focusedPaneId: 'left', visiblePaneIds: new Set(['left']) });
    expect(clearFindInPane).toHaveBeenCalledExactlyOnceWith('right');
    expect(api.searchPaneId).toBeNull();
  });
});
