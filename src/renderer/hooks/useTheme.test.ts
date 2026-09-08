// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useTheme } from './useTheme';
import { getTheme } from '../styles/themes';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
let theme: ReturnType<typeof useTheme>;
const persist = vi.fn().mockResolvedValue(undefined);
const overlay = vi.fn();

function Harness() {
  theme = useTheme();
  return null;
}

beforeEach(async () => {
  vi.stubGlobal('electronAPI', {
    config: { get: vi.fn().mockResolvedValue('mocha'), set: persist },
    titlebar: { updateOverlay: overlay },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(createElement(Harness)); });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.documentElement.removeAttribute('style');
  delete document.documentElement.dataset.theme;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it('previews the interface and terminal palette without persisting', () => {
  act(() => theme.previewTheme('default-dark'));
  expect(theme.themeName).toBe('default-dark');
  expect(document.documentElement.dataset.theme).toBe('default-dark');
  expect(theme.xtermTheme).toBe(getTheme('default-dark').xterm);
  expect(overlay).toHaveBeenLastCalledWith(...Object.values(getTheme('default-dark').titlebar));
  expect(persist).not.toHaveBeenCalled();
});

it('can restore the opening palette without changing the saved preference', () => {
  const opening = theme.themeName;
  act(() => theme.previewTheme('tether-light'));
  act(() => theme.previewTheme(opening));
  expect(document.documentElement.dataset.theme).toBe('mocha');
  expect(theme.xtermTheme).toBe(getTheme('mocha').xterm);
  expect(persist).not.toHaveBeenCalled();
});

it('keeps explicit menu theme changes persistent', () => {
  act(() => theme.setTheme('brass'));
  expect(theme.themeName).toBe('brass');
  expect(persist).toHaveBeenCalledExactlyOnceWith('theme', 'brass');
});
