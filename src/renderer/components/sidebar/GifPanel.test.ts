// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GifPanel } from './GifPanel';
import { DEFAULT_GIF_PANEL_SETTINGS, type GifPanelSettings, type GifPanelSettingsPatch } from '../../../shared/gif-panel';

let container: HTMLDivElement;
let root: Root;
let settings: GifPanelSettings;
let images: Array<{ id: string; name: string; version: string }>;
let hidden = false;
let reduced = false;
const getLibrary = vi.fn();
const readImage = vi.fn();
const updateSettings = vi.fn();

function Harness() {
  const [value, setValue] = useState(settings);
  return React.createElement(GifPanel, { settings: value, onSettingsChange: setValue });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  hidden = false;
  reduced = false;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  vi.stubGlobal('matchMedia', () => ({ matches: reduced, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  settings = { ...DEFAULT_GIF_PANEL_SETTINGS, enabled: true, sources: ['/gifs'] };
  images = [{ id: 'a', name: 'first.gif', version: '1' }, { id: 'b', name: 'second.gif', version: '1' }];
  getLibrary.mockImplementation(async () => ({ images: [...images], warnings: [] }));
  readImage.mockImplementation(async (id: string) => `data:image/gif;base64,${id}`);
  updateSettings.mockImplementation(async (patch: GifPanelSettingsPatch) => (settings = { ...settings, ...patch }));
  vi.stubGlobal('electronAPI', { gifPanel: { getLibrary, readImage, updateSettings } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount() { await act(async () => root.render(React.createElement(Harness))); }
async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find(item => item.getAttribute('aria-label') === label || item.textContent === label);
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}

it('navigates, shuffles away from the current image, and remembers the selection', async () => {
  await mount();
  expect(container.querySelector('img')?.alt).toBe('first.gif');
  await click('Next GIF');
  expect(container.querySelector('img')?.alt).toBe('second.gif');
  expect(localStorage.getItem('tether.gifPanel.currentImage')).toBe('b');
  await click('Shuffle GIF');
  expect(container.querySelector('img')?.alt).toBe('first.gif');
  await click('Previous GIF');
  expect(container.querySelector('img')?.alt).toBe('second.gif');
});

it.each([0, 0xffffffff])('shuffles within the collection without repeats for crypto sample %i', async sample => {
  images.push({ id: 'c', name: 'third.gif', version: '1' });
  const random = vi.spyOn(globalThis.crypto, 'getRandomValues').mockReturnValue(new Uint32Array([sample]));
  await mount();
  const visited = new Set<string>();
  for (let index = 0; index < images.length; index++) {
    const previous = container.querySelector('img')!.alt;
    visited.add(previous);
    await click('Shuffle GIF');
    expect(container.querySelector('img')!.alt).not.toBe(previous);
  }
  expect(visited.size).toBe(3);
  expect(container.querySelector('img')?.alt).toBe('first.gif');
  expect(random).toHaveBeenCalledTimes(3);
});

it('removes images and timers when collapsed or hidden, then resumes when visible', async () => {
  settings.rotationEnabled = true;
  await mount();
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(container.querySelector('img')?.alt).toBe('second.gif');
  await click('GIF Panel');
  expect(container.querySelector('img')).toBeNull();
  const reads = readImage.mock.calls.length;
  const scans = getLibrary.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(readImage).toHaveBeenCalledTimes(reads);
  expect(getLibrary).toHaveBeenCalledTimes(scans);
  await click('GIF Panel');
  expect(container.querySelector('img')).not.toBeNull();
  await act(async () => { hidden = true; document.dispatchEvent(new Event('visibilitychange')); });
  expect(container.querySelector('img')).toBeNull();
  const hiddenReads = readImage.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(readImage).toHaveBeenCalledTimes(hiddenReads);
  await act(async () => { hidden = false; document.dispatchEvent(new Event('visibilitychange')); });
  expect(container.querySelector('img')).not.toBeNull();
});

it('does not load animations under reduced motion until explicitly requested', async () => {
  reduced = true;
  settings.rotationEnabled = true;
  await mount();
  expect(readImage).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(readImage).not.toHaveBeenCalled();
  await click('Play GIFs');
  expect(container.querySelector('img')).not.toBeNull();
  await click('Folders & options');
  await click('Stop animations');
  expect(container.querySelector('img')).toBeNull();
});

it('ignores a late image response after navigating to a newer image', async () => {
  let resolveFirst: (url: string) => void = () => {};
  readImage.mockImplementation((id: string) => id === 'a' ? new Promise<string>(resolve => { resolveFirst = resolve; }) : Promise.resolve('data:image/gif;base64,b'));
  await mount();
  await click('Next GIF');
  await act(async () => resolveFirst('data:image/gif;base64,a'));
  expect(container.querySelector('img')?.alt).toBe('second.gif');
  expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/gif;base64,b');
});

it('refreshes the collection and lets a failed image be skipped', async () => {
  readImage.mockRejectedValueOnce(new Error('Image was removed'));
  await mount();
  expect(container.textContent).toContain('Image was removed');
  await click('Next GIF');
  expect(container.querySelector('img')?.alt).toBe('second.gif');
  images = [{ id: 'c', name: 'new.gif', version: '2' }];
  await click('Rescan');
  expect(container.querySelector('img')?.alt).toBe('new.gif');
});
