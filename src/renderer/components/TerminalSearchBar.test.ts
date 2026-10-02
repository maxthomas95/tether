// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalSearchBar } from './TerminalSearchBar';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
let frames: FrameRequestCallback[];

const onSearch = vi.fn(() => true);
const onResults = vi.fn(() => () => {});
const onClose = vi.fn();

function render(focusRequest: number) {
  act(() => {
    root.render(createElement(TerminalSearchBar, {
      paneId: 'pane-a',
      focusRequest,
      onSearch,
      onResults,
      onClose,
    }));
  });
}

function flushFrames() {
  act(() => { for (const callback of frames.splice(0)) callback(0); });
}

beforeEach(() => {
  vi.clearAllMocks();
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('TerminalSearchBar', () => {
  it('refocuses and selects the input when the focus request changes', () => {
    const select = vi.spyOn(HTMLInputElement.prototype, 'select');
    render(1);
    flushFrames();
    const input = host.querySelector<HTMLInputElement>('.terminal-search-input')!;
    expect(document.activeElement).toBe(input);
    expect(select).toHaveBeenCalledOnce();

    render(2);
    flushFrames();
    expect(document.activeElement).toBe(input);
    expect(select).toHaveBeenCalledTimes(2);
  });

  it('closes on Escape from any search-bar control and labels compact toggles', () => {
    render(1);
    flushFrames();
    const matchCase = host.querySelector<HTMLButtonElement>('[aria-label="Match case"]')!;
    const wholeWord = host.querySelector<HTMLButtonElement>('[aria-label="Match whole word"]')!;
    expect(matchCase).not.toBeNull();
    expect(wholeWord).not.toBeNull();

    act(() => {
      matchCase.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
