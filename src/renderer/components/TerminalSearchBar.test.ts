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
const onResults = vi.fn((_: string, listener: (event: { resultIndex: number; resultCount: number }) => void) => {
  resultListener = listener;
  return unsubscribeResults;
});
const unsubscribeResults = vi.fn();
let resultListener: ((event: { resultIndex: number; resultCount: number }) => void) | undefined;
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

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  vi.clearAllMocks();
  resultListener = undefined;
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



  it('runs incremental, navigation, and option searches without closing', () => {
    render(1);
    flushFrames();
    const input = host.querySelector<HTMLInputElement>('.terminal-search-input')!;
    act(() => {
      setInputValue(input, 'alpha');
    });
    expect(onSearch).toHaveBeenLastCalledWith('pane-a', 'alpha', {
      caseSensitive: false,
      wholeWord: false,
      previous: undefined,
      incremental: true,
    });

    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(onSearch).toHaveBeenLastCalledWith('pane-a', 'alpha', {
      caseSensitive: false,
      wholeWord: false,
      previous: false,
      incremental: undefined,
    });

    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(onSearch).toHaveBeenLastCalledWith('pane-a', 'alpha', {
      caseSensitive: false,
      wholeWord: false,
      previous: true,
      incremental: undefined,
    });

    const matchCase = host.querySelector<HTMLButtonElement>('[aria-label="Match case"]')!;
    const wholeWord = host.querySelector<HTMLButtonElement>('[aria-label="Match whole word"]')!;
    act(() => matchCase.click());
    expect(matchCase.getAttribute('aria-pressed')).toBe('true');
    expect(onSearch).toHaveBeenLastCalledWith('pane-a', 'alpha', expect.objectContaining({ caseSensitive: true, wholeWord: false, incremental: true }));
    act(() => wholeWord.click());
    expect(wholeWord.getAttribute('aria-pressed')).toBe('true');
    expect(onSearch).toHaveBeenLastCalledWith('pane-a', 'alpha', expect.objectContaining({ caseSensitive: true, wholeWord: true, incremental: true }));

    const previous = host.querySelector<HTMLButtonElement>('[aria-label="Previous match"]')!;
    const next = host.querySelector<HTMLButtonElement>('[aria-label="Next match"]')!;
    act(() => previous.click());
    expect(onSearch).toHaveBeenLastCalledWith('pane-a', 'alpha', expect.objectContaining({ previous: true }));
    act(() => next.click());
    expect(onSearch).toHaveBeenLastCalledWith('pane-a', 'alpha', expect.objectContaining({ previous: undefined }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows match counts, no-result status, and clears empty searches', () => {
    onSearch.mockImplementation((_, term) => term !== 'missing');
    render(1);
    flushFrames();
    const input = host.querySelector<HTMLInputElement>('.terminal-search-input')!;
    act(() => {
      setInputValue(input, 'missing');
    });
    expect(host.querySelector('.terminal-search-status')?.textContent).toBe('No results');

    act(() => resultListener?.({ resultIndex: 1, resultCount: 5 }));
    expect(host.querySelector('.terminal-search-status')?.textContent).toBe('2/5');
    act(() => resultListener?.({ resultIndex: -1, resultCount: 5 }));
    expect(host.querySelector('.terminal-search-status')?.textContent).toBe('5 matches');

    act(() => {
      setInputValue(input, '');
    });
    expect(onSearch).toHaveBeenLastCalledWith('pane-a', '', { caseSensitive: false, wholeWord: false, incremental: true });
    expect(host.querySelector('.terminal-search-status')?.textContent).toBe('');
  });

  it('unsubscribes from result updates on unmount', () => {
    render(1);
    expect(onResults).toHaveBeenCalledExactlyOnceWith('pane-a', expect.any(Function));
    act(() => root.unmount());
    expect(unsubscribeResults).toHaveBeenCalledOnce();
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
