// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SessionInfo, TetherAPI } from '../../shared/types';
import { useWorkspacePersistence } from './useWorkspacePersistence';
import { initializeWorkspace } from '../utils/workspace-initialization';

let root: Root;
let host: HTMLDivElement;
let controls: ReturnType<typeof useWorkspacePersistence>;
const save = vi.fn().mockResolvedValue(undefined);
const notify = vi.fn().mockReturnValue('notice-1');
const confirm = vi.fn().mockResolvedValue({ confirmed: false, checkboxValue: false });
const noSessions: SessionInfo[] = [];

function Fixture({ sessions, activeSessionId, canvas, ready }: {
  sessions: SessionInfo[];
  activeSessionId?: string | null;
  canvas?: Parameters<typeof useWorkspacePersistence>[2];
  ready: boolean;
}) {
  controls = useWorkspacePersistence(sessions, activeSessionId ?? sessions[0]?.id ?? null, canvas, ready, { notify, confirm });
  return null;
}

function render(sessions = noSessions, ready = false, canvas?: Parameters<typeof useWorkspacePersistence>[2], activeSessionId?: string | null) {
  act(() => root.render(createElement(Fixture, { sessions, canvas, activeSessionId, ready })));
}

function flushSave() {
  act(() => vi.advanceTimersByTime(250));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  window.electronAPI = { workspace: { save } } as unknown as TetherAPI;
  save.mockReset().mockResolvedValue(undefined);
  notify.mockClear();
  confirm.mockReset().mockResolvedValue({ confirmed: false, checkboxValue: false });
  host = document.createElement('div');
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

it('keeps the original saved entry when every session fails to restore', () => {
  render();
  const failed = { workingDir: '/repo', label: 'Saved', launchSnapshotId: 'protected-1', toolSessionId: 'native-1' };
  act(() => controls.retainFailedSessions([failed]));
  expect(save).not.toHaveBeenCalled();
  render(noSessions, true);
  flushSave();
  expect(save).toHaveBeenLastCalledWith([{ ...failed, restorePending: true }], 0, undefined);
});

it('keeps failed entries through successful session changes and forgets them only explicitly', () => {
  render();
  const failed = { workingDir: '/failed', label: 'Retry next launch', launchSnapshotId: 'protected-1' };
  act(() => controls.retainFailedSessions([failed]));
  const live = {
    id: 'live-1', workingDir: '/live', label: 'Live', state: 'running', cliTool: 'codex',
    toolSessionId: 'native-live', launchSnapshotId: 'protected-live', env: { PRIVATE_VALUE: 'secret' },
  } as unknown as SessionInfo;
  render([live], true);
  flushSave();
  const saved = save.mock.calls.at(-1)![0];
  expect(saved).toHaveLength(2);
  expect(saved[0]).toMatchObject({ workingDir: '/live', launchSnapshotId: 'protected-live', toolSessionId: 'native-live' });
  expect(saved[0]).not.toHaveProperty('env');
  expect(saved[1]).toEqual({ ...failed, restorePending: true });
  render(noSessions, true);
  flushSave();
  expect(save).toHaveBeenLastCalledWith([{ ...failed, restorePending: true }], 0, undefined);
  act(() => controls.forgetFailedSessions());
  flushSave();
  expect(save).toHaveBeenLastCalledWith([], 0, undefined);
});

it('requires confirmation to forget failed entries from a recovery notification', async () => {
  render();
  const saved = { workingDir: '/repo', label: 'Saved', launchSnapshotId: 'protected-1' };
  act(() => controls.reportRestoreFailures([{ label: saved.label, error: 'Keychain unavailable', saved }]));
  render(noSessions, true);
  flushSave();
  const notice = notify.mock.calls.at(-1)![0];
  expect(notice.title).toBe('Failed to restore Saved');
  expect(notice.message).toContain('retried');
  await act(async () => notice.action.onClick());
  expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ danger: true }));
  expect(save).toHaveBeenLastCalledWith([{ ...saved, restorePending: true }], 0, undefined);
  confirm.mockResolvedValueOnce({ confirmed: true, checkboxValue: false });
  await act(async () => notice.action.onClick());
  flushSave();
  expect(save).toHaveBeenLastCalledWith([], 0, undefined);
});

it('reattaches pending entries after a renderer reload without retaining live rows twice', () => {
  render();
  act(() => controls.retainPendingRestores([{ workingDir: '/live', label: 'Live' }]));
  expect(notify).not.toHaveBeenCalled();
  const pending = { workingDir: '/failed', label: 'Failed', launchSnapshotId: 'opaque', restorePending: true };
  act(() => controls.retainPendingRestores([{ workingDir: '/live', label: 'Live' }, pending]));
  render(noSessions, true);
  flushSave();
  expect(save).toHaveBeenLastCalledWith([pending], 0, undefined);
  expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'warning' }));
});

it('reports multiple restore failures and leaves successful empty restores quiet', () => {
  render();
  act(() => controls.reportRestoreFailures([]));
  expect(notify).not.toHaveBeenCalled();
  const failures = ['First', 'Second'].map(label => ({ label, error: 'Missing launch settings', saved: { label, workingDir: '/repo' } }));
  act(() => controls.reportRestoreFailures(failures));
  expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Failed to restore 2 sessions' }));
  render(noSessions, true);
  flushSave();
  expect(save.mock.calls.at(-1)![0]).toHaveLength(2);
});

it.each(['environment', 'layout'])('keeps the saved workspace when the %s startup read fails', async failingRead => {
  const original = [{ workingDir: '/saved', toolSessionId: 'native-1', launchSnapshotId: 'protected-1' }];
  let stored = original;
  save.mockImplementation(async value => { stored = value; });
  render();
  const error = new Error(`${failingRead} read failed`);
  await act(async () => initializeWorkspace(async () => {
    if (failingRead === 'environment') throw error;
    await Promise.resolve();
    throw error;
  }, { isMounted: () => true, onReady: () => render(noSessions, true), onError: notify }));
  expect(stored).toBe(original);
  expect(save).not.toHaveBeenCalled();
  expect(notify).toHaveBeenCalledWith(error);
});

it('enables saving after a successful empty restore and ignores completion after unmount', async () => {
  render();
  await act(async () => initializeWorkspace(async () => {}, {
    isMounted: () => true, onReady: () => render(noSessions, true), onError: notify,
  }));
  flushSave();
  expect(save).toHaveBeenCalledExactlyOnceWith([], 0, undefined);
  const ready = vi.fn();
  for (const restore of [async () => {}, async () => { throw new Error('late failure'); }]) {
    await initializeWorkspace(restore, { isMounted: () => false, onReady: ready, onError: notify });
  }
  expect(ready).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalled();
});

it('does not save a state-only session change', () => {
  const session = { id: 's1', workingDir: '/repo', label: 'API', state: 'running', cliTool: 'codex' } as SessionInfo;
  render([session], true);
  flushSave();
  render([{ ...session, state: 'waiting' }], true);
  flushSave();
  expect(save).toHaveBeenCalledTimes(1);
});

it('saves a label change once after the trailing debounce', () => {
  const session = { id: 's1', workingDir: '/repo', label: 'API', state: 'running' } as SessionInfo;
  render([session], true);
  flushSave();
  render([{ ...session, label: 'Backend' }], true);
  act(() => vi.advanceTimersByTime(249));
  expect(save).toHaveBeenCalledTimes(1);
  flushSave();
  expect(save).toHaveBeenCalledTimes(2);
  expect(save).toHaveBeenLastCalledWith([expect.objectContaining({ label: 'Backend' })], 0, undefined);
});

it('coalesces rapid canvas changes into the final save', () => {
  const canvas = (x: number) => ({ panels: [{ sessionIndex: 0, x, y: 0, width: 300, height: 200, z: 1 }], viewport: { x: 0, y: 0 }, focusedSessionIndex: 0 });
  render(noSessions, true, canvas(1));
  render(noSessions, true, canvas(2));
  render(noSessions, true, canvas(3));
  flushSave();
  expect(save).toHaveBeenCalledExactlyOnceWith([], 0, canvas(3));
});

it('flushes a pending workspace save on pagehide', () => {
  const session = { id: 's1', workingDir: '/repo', label: 'API', state: 'running' } as SessionInfo;
  render([session], true);
  act(() => window.dispatchEvent(new Event('pagehide')));
  expect(save).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({ label: 'API' })], 0, undefined);
});
