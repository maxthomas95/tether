// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SettingsDialog } from './SettingsDialog';
import { JobsOfficePill } from './sidebar/JobsOfficePill';
import { DEFAULT_JOBS_SETTINGS } from '../../shared/jobs';
import { DEFAULT_NOTIFICATION_PREFS, type JobsSettings, type JobsStatus } from '../../shared/types';
import type { KeybindingAction, Chord } from '../../shared/keybindings';

let container: HTMLDivElement;
let root: Root;
let saved: JobsSettings;
let status: JobsStatus;
let api: ReturnType<typeof makeApi>;
const onClose = vi.fn();
const nothing = async () => {};
const subscribe = () => () => {};
function makeApi() {
  return {
    config: { get: async () => null, set: vi.fn(nothing), getDefaultEnvVars: async () => ({}), getDefaultCliFlagsPerTool: async () => ({}), setDefaultEnvVars: nothing, setDefaultCliFlagsForTool: nothing },
    profile: { list: async () => [] }, gitProvider: { list: async () => [] }, knownHosts: { list: async () => [] },
    vault: { getConfig: async () => ({ enabled: false, addr: '', role: '', mount: 'secret', namespace: '' }), status: async () => ({ enabled: false, loggedIn: false }), onStatusChange: subscribe, setConfig: nothing },
    notifications: { getPrefs: async () => DEFAULT_NOTIFICATION_PREFS, setPrefs: nothing },
    quota: { setEnabled: nothing },
    jobs: {
      getSettings: vi.fn(async () => ({ ...saved })), getStatus: async () => status, onStatusChange: subscribe,
      saveSettings: vi.fn(async (settings: JobsSettings) => {
        saved = { ...settings };
        status = { ...status, enabled: saved.enabled, detected: saved.enabled === 'auto', phase: saved.enabled === 'auto' ? 'connected' : 'off' };
        return status;
      }),
      disable: vi.fn(async () => { saved.enabled = 'off'; status = { ...status, enabled: 'off', detected: false, phase: 'off' }; return status; }),
      remove: vi.fn(async () => { saved = { ...DEFAULT_JOBS_SETTINGS }; status = { ...status, enabled: 'off', detected: false, phase: 'off' }; return status; }),
    },
    docs: { open: nothing }, shell: { openExternal: nothing }, dialog: { openDirectory: async () => null },
  };
}
async function render(isOpen = true) {
  await act(async () => root.render(React.createElement(SettingsDialog, {
    isOpen, onClose, currentTheme: 'mocha', onThemeChange: () => {}, onResetSessionFontSizes: () => {},
    keybindings: {} as Record<KeybindingAction, Chord | null>, onKeybindingChange: () => {}, onKeybindingsResetAll: () => {},
  })));
}
const click = async (label: string) => {
  const button = [...container.querySelectorAll('button')].find(el => el.textContent === label);
  expect(button, `button ${label}`).toBeDefined();
  await act(async () => button!.click());
};
const toggle = async (label: string) => {
  const input = [...container.querySelectorAll('label')].find(el => el.textContent?.includes(label))?.querySelector('input');
  expect(input, `checkbox ${label}`).toBeDefined();
  await act(async () => input!.click());
};

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  onClose.mockClear();
  saved = { ...DEFAULT_JOBS_SETTINGS };
  status = { enabled: 'off', detected: false, url: saved.url, version: null, managed: false, phase: 'off' };
  api = makeApi();
  vi.stubGlobal('electronAPI', api);
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it('enables office viewing without opting into sharing or automatic launch', async () => {
  await render(); await click('Integrations');
  expect(container.textContent).toContain('Off — no connection or session sharing');
  await toggle('Enable JOBS connection');
  expect(api.jobs.saveSettings).not.toHaveBeenCalled();
  await click('Save and connect');
  expect(saved).toMatchObject({ enabled: 'auto', shareRemoteSessions: false, autoLaunch: false });
  expect(container.textContent).toContain('Connected');
});

it('turns sharing off while keeping the office connected and retains setup when paused', async () => {
  saved = { ...saved, enabled: 'auto', shareRemoteSessions: true, token: 'secret', path: '/office' };
  status = { ...status, enabled: 'auto', detected: true, phase: 'connected' };
  await render(); await click('Integrations');
  await toggle('Share SSH and Coder sessions');
  await click('Save and connect');
  expect(saved).toMatchObject({ enabled: 'auto', shareRemoteSessions: false, token: 'secret' });
  await click('Turn off now');
  expect(saved).toMatchObject({ enabled: 'off', token: 'secret', path: '/office' });
  expect(container.textContent).toContain('Off — no connection or session sharing');
});

it('removes saved settings and clears the draft so global Save cannot restore them', async () => {
  saved = { ...saved, enabled: 'auto', shareRemoteSessions: true, token: 'secret', path: '/office' };
  status = { ...status, enabled: 'auto', detected: true, phase: 'connected' };
  await render(); await click('Integrations');
  await toggle('Share SSH and Coder sessions');
  await click('Remove integration…');
  expect(api.jobs.remove).not.toHaveBeenCalled();
  await click('Remove and forget');
  expect(saved).toEqual(DEFAULT_JOBS_SETTINGS);
  await click('Save');
  expect(api.jobs.saveSettings).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledOnce();
});

it('keeps failed saves visible and permits retry', async () => {
  await render(); await click('Integrations');
  await toggle('Enable JOBS connection');
  api.jobs.saveSettings.mockRejectedValueOnce(new Error('Enter a valid JOBS URL.'));
  await click('Save and connect');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Enter a valid JOBS URL');
  expect(container.textContent).toContain('Unsaved JOBS changes');
  await click('Save and connect');
  expect(container.textContent).toContain('Connected');
});

it('does not overwrite JOBS settings during unrelated saves when loading its token fails', async () => {
  api.jobs.getSettings.mockRejectedValueOnce(new Error('keychain unavailable'));
  await render(); await click('Integrations');
  expect(container.textContent).toContain('Could not load JOBS settings');
  await click('Save');
  expect(api.jobs.saveSettings).not.toHaveBeenCalled();
});

it('discards unapplied JOBS edits when the dialog is cancelled and reopened', async () => {
  await render(); await click('Integrations');
  await toggle('Enable JOBS connection');
  await click('Cancel');
  await render(false); await render();
  expect(container.querySelector<HTMLInputElement>('#jobs-url')).toBeNull();
  expect(api.jobs.saveSettings).not.toHaveBeenCalled();
});

it('offers settings for an unavailable office and hides the sidebar entry after opt-out', async () => {
  const onConfigure = vi.fn();
  const onToggle = vi.fn();
  status = { ...status, enabled: 'auto', phase: 'unavailable' };
  await act(async () => root.render(React.createElement(JobsOfficePill, { status, active: false, onToggle, onConfigure })));
  expect(container.textContent).toContain('Office unavailable');
  await act(async () => container.querySelector<HTMLElement>('[role="button"]')!.click());
  expect(onConfigure).toHaveBeenCalledOnce();
  expect(onToggle).not.toHaveBeenCalled();
  await act(async () => root.render(React.createElement(JobsOfficePill, { status: { ...status, enabled: 'off' }, active: false, onToggle, onConfigure })));
  expect(container.textContent).toBe('');
});
