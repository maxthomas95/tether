// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class FakeTerminal {
    static instances: FakeTerminal[] = [];
    options: Record<string, unknown>;
    loadAddon = vi.fn();
    open = vi.fn((_container: HTMLDivElement) => {});
    write = vi.fn();
    dispose = vi.fn();
    constructor(options: Record<string, unknown>) {
      this.options = options;
      FakeTerminal.instances.push(this);
    }
  }
  return { FakeTerminal, fit: vi.fn() };
});
vi.mock('@xterm/xterm', () => ({ Terminal: mocks.FakeTerminal }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit = mocks.fit; } }));

import { TerminalAppearancePreview } from './TerminalAppearancePreview';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let resize: ResizeObserverCallback;
let disconnect: ReturnType<typeof vi.fn>;

function render(fontFamily = "'Iosevka Fixed', monospace") {
  act(() => root.render(createElement(TerminalAppearancePreview, { themeName: 'harbor', fontFamily, fontSize: 14 })));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.FakeTerminal.instances = [];
  disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resize = callback; }
    observe = vi.fn();
    disconnect = disconnect;
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  Reflect.deleteProperty(document, 'fonts');
  vi.unstubAllGlobals();
});

it('cancels pending font previews when the selection changes or settings close', async () => {
  const pending: (() => void)[] = [];
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { load: () => new Promise<void>(resolve => pending.push(resolve)) },
  });
  render();
  render("'IBM Plex Mono', monospace");
  await act(async () => { pending.splice(0, 4).forEach(resolve => resolve()); });
  expect(mocks.FakeTerminal.instances).toHaveLength(0);
  await act(async () => { pending.splice(0).forEach(resolve => resolve()); });
  const terminal = mocks.FakeTerminal.instances[0];
  expect(terminal.options).toMatchObject({ fontFamily: "'IBM Plex Mono', monospace", disableStdin: true, scrollback: 0 });
  render();
  expect(terminal.dispose).toHaveBeenCalledOnce();
  expect(disconnect).toHaveBeenCalledOnce();
  act(() => root.render(null));
  await act(async () => { pending.splice(0).forEach(resolve => resolve()); });
  expect(mocks.FakeTerminal.instances).toHaveLength(1);
});

it('fits a visible preview on resize and leaves hidden previews alone', async () => {
  render('');
  await act(async () => {});
  const terminal = mocks.FakeTerminal.instances[0];
  expect(terminal.options.fontFamily).toContain('Cascadia Code');
  const container = terminal.open.mock.calls[0][0] as HTMLDivElement;
  resize([], {} as ResizeObserver);
  expect(mocks.fit).not.toHaveBeenCalled();
  Object.defineProperties(container, { clientWidth: { value: 500 }, clientHeight: { value: 160 } });
  resize([], {} as ResizeObserver);
  expect(mocks.fit).toHaveBeenCalledOnce();
  expect(host.querySelector('[role="img"]')?.getAttribute('aria-label')).toContain('sixteen ANSI colors');
});

it('keeps the preview available using fallbacks when a font fails to load', async () => {
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { load: () => Promise.reject(new Error('font unavailable')) },
  });
  render();
  await act(async () => {});
  expect(mocks.FakeTerminal.instances).toHaveLength(1);
  expect(mocks.FakeTerminal.instances[0].open).toHaveBeenCalledOnce();
});
