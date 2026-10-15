// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useTheme } from './useTheme';
import { DEFAULT_THEME, getTheme, setLocalThemes } from '../styles/themes';
import example from '../../shared/example-theme.json';
import { parseThemeFile } from '../../shared/theme-format';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
let theme: ReturnType<typeof useTheme>;
const persist = vi.fn().mockResolvedValue(undefined);
const overlay = vi.fn().mockResolvedValue(undefined);
const onError = vi.fn();
const catalog = { directory: '/themes', themes: [], issues: [] };
const list = vi.fn().mockResolvedValue(catalog);
const reload = vi.fn().mockResolvedValue(catalog);

function Harness() {
  theme = useTheme(onError);
  return null;
}

beforeEach(async () => {
  vi.stubGlobal('electronAPI', {
    themes: { list, reload },
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
  setLocalThemes([]);
  list.mockResolvedValue(catalog);
  reload.mockResolvedValue(catalog);
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
  act(() => theme.setTheme('harbor'));
  expect(theme.themeName).toBe('harbor');
  expect(persist).toHaveBeenCalledExactlyOnceWith('theme', 'harbor');
});

it('keeps the selected palette and reports a failed preference write', async () => {
  const error = new Error('write failed');
  persist.mockRejectedValueOnce(error);
  overlay.mockRejectedValueOnce(new Error('overlay unavailable'));
  await act(async () => theme.setTheme('harbor'));
  expect(theme.themeName).toBe('harbor');
  expect(onError).toHaveBeenCalledWith('Could not save the theme', error);
});

it('applies the default palette when the saved preference cannot be read', async () => {
  await act(async () => root.unmount());
  window.electronAPI.config.get = vi.fn().mockRejectedValue(new Error('read failed'));
  root = createRoot(container);
  await act(async () => root.render(createElement(Harness)));
  expect(theme.themeName).toBe(DEFAULT_THEME);
  expect(document.documentElement.dataset.theme).toBe(DEFAULT_THEME);
});

it.each(['resolve', 'reject'])('ignores a late saved-theme %s after unmount', async outcome => {
  await act(async () => root.unmount());
  let resolve!: (value: string) => void;
  let reject!: (error: Error) => void;
  window.electronAPI.config.get = vi.fn(() => new Promise<string | null>((done, fail) => { resolve = done; reject = fail; }));
  root = createRoot(container);
  await act(async () => root.render(createElement(Harness)));
  overlay.mockClear();
  await act(async () => root.unmount());
  await act(async () => {
    if (outcome === 'resolve') resolve('harbor');
    else reject(new Error('late failure'));
  });
  expect(overlay).not.toHaveBeenCalled();
});


it('loads a saved local theme across app surfaces, native controls, titlebar, and terminal', async () => {
  await act(async () => root.unmount());
  const local = parseThemeFile({ ...example, id: 'private', label: 'Private', isDark: false });
  list.mockResolvedValueOnce({ ...catalog, themes: [local] });
  window.electronAPI.config.get = vi.fn().mockResolvedValue(local.name);
  root = createRoot(container);
  await act(async () => root.render(createElement(Harness)));
  expect(theme.themeName).toBe(local.name);
  expect(theme.themeList.some(item => item.name === local.name)).toBe(true);
  expect(theme.xtermTheme).toEqual(local.xterm);
  for (const [key, value] of Object.entries(local.css)) expect(document.documentElement.style.getPropertyValue(key)).toBe(value);
  expect(document.documentElement.style.colorScheme).toBe('light');
  expect(document.documentElement.style.getPropertyValue('--inner-highlight')).toBe('0 0 0 0 transparent');
  expect(overlay).toHaveBeenLastCalledWith(local.titlebar.color, local.titlebar.symbolColor);
});

it('reloads edits to the same id and falls back coherently when the selected file disappears', async () => {
  const local = parseThemeFile({ ...example, id: 'private' });
  reload.mockResolvedValueOnce({ ...catalog, themes: [local] });
  await act(async () => theme.reloadThemes());
  act(() => theme.previewTheme(local.name));
  const edited = { ...local, css: { ...local.css, '--surface-3': '#123456' }, xterm: { ...local.xterm, cursor: '#abcdef' } };
  reload.mockResolvedValueOnce({ ...catalog, themes: [edited] });
  await act(async () => theme.reloadThemes());
  expect(theme.themeName).toBe(local.name);
  expect(document.documentElement.style.getPropertyValue('--surface-3')).toBe('#123456');
  expect(theme.xtermTheme.cursor).toBe('#abcdef');
  await act(async () => theme.reloadThemes());
  expect(theme.themeName).toBe(DEFAULT_THEME);
  expect(theme.xtermTheme).toBe(getTheme(DEFAULT_THEME).xterm);
  expect(persist).not.toHaveBeenCalled();
});
