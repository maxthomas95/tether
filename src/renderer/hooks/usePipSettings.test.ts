// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { usePipSettings } from './usePipSettings';
import { DEFAULT_PIP_SETTINGS, PIP_SETTINGS_KEY } from '../lib/pip-settings';
import { deferred } from '../components/visibility.test-helper';

let container: HTMLDivElement;
let root: Root;
let preferences: ReturnType<typeof usePipSettings>;
const get = vi.fn();
const set = vi.fn();
const error = vi.fn();
function Harness() { preferences = usePipSettings(error); return null; }
async function mount() { await act(async () => root.render(createElement(Harness))); }

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  get.mockResolvedValue(null);
  set.mockResolvedValue(undefined);
  vi.stubGlobal('electronAPI', { config: { get, set } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it('loads preferences and saves only known JSON settings through existing config', async () => {
  get.mockResolvedValue('{"enabled":true,"personality":"sweet","quiet":true}');
  await mount();
  expect(get).toHaveBeenCalledWith(PIP_SETTINGS_KEY);
  expect(preferences.settings?.quiet).toBe(true);
  await act(async () => preferences.update({ motion: false }));
  expect(JSON.parse(set.mock.calls[0][1])).toEqual({ ...DEFAULT_PIP_SETTINGS, enabled: true, quiet: true, personality: 'sweet', motion: false });
  await act(async () => preferences.toggle());
  expect(preferences.settings?.enabled).toBe(false);
});

it('keeps the last saved preferences when persistence fails', async () => {
  await mount();
  set.mockRejectedValueOnce(new Error('disk full'));
  await act(async () => preferences.update({ enabled: true }));
  expect(preferences.settings).toEqual(DEFAULT_PIP_SETTINGS);
  expect(preferences.busy).toBe(false);
  expect(error).toHaveBeenCalledWith('Could not save Pip preferences', expect.any(Error));
});

it('prevents overlapping saves from overwriting a newer preference', async () => {
  await mount();
  const pending = deferred<void>();
  set.mockReturnValueOnce(pending.promise);
  let saving!: Promise<void>;
  await act(async () => { saving = preferences.update({ enabled: true }); });
  expect(preferences.busy).toBe(true);
  await act(async () => preferences.update({ quiet: true }));
  expect(set).toHaveBeenCalledTimes(1);
  await act(async () => { pending.resolve(); await saving; });
  expect(preferences.settings?.enabled).toBe(true);
  await act(async () => preferences.update({ quiet: true }));
  expect(preferences.settings?.quiet).toBe(true);
});

it('reports load failures without enabling the panel or saving defaults', async () => {
  get.mockRejectedValueOnce(new Error('unavailable'));
  await mount();
  expect(preferences.settings).toBeNull();
  await act(async () => preferences.toggle());
  expect(set).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledWith('Could not load Pip preferences', expect.any(Error));
});

it('ignores a load result that arrives after unmount', async () => {
  const pending = deferred<string | null>();
  get.mockReturnValueOnce(pending.promise);
  await mount();
  await act(async () => root.unmount());
  await act(async () => pending.resolve('{"enabled":true}'));
  expect(preferences.settings).toBeNull();
});
