// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SessionInfo, TetherAPI } from '../../shared/types';
import { useWorkspacePersistence } from './useWorkspacePersistence';

let root: Root;
let host: HTMLDivElement;
let controls: ReturnType<typeof useWorkspacePersistence>;
const save = vi.fn().mockResolvedValue(undefined);
const notify = vi.fn().mockReturnValue('notice-1');
const confirm = vi.fn().mockResolvedValue({ confirmed: false, checkboxValue: false });
const noSessions: SessionInfo[] = [];

function Fixture({ sessions, ready }: { sessions: SessionInfo[]; ready: boolean }) {
  controls = useWorkspacePersistence(sessions, sessions[0]?.id ?? null, undefined, ready, { notify, confirm });
  return null;
}

function render(sessions = noSessions, ready = false) {
  act(() => root.render(createElement(Fixture, { sessions, ready })));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.electronAPI = { workspace: { save } } as unknown as TetherAPI;
  save.mockClear();
  notify.mockClear();
  confirm.mockReset().mockResolvedValue({ confirmed: false, checkboxValue: false });
  host = document.createElement('div');
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
});

it('keeps the original saved entry when every session fails to restore', () => {
  render();
  const failed = { workingDir: '/repo', label: 'Saved', launchSnapshotId: 'protected-1', toolSessionId: 'native-1' };
  act(() => controls.retainFailedSessions([failed]));
  expect(save).not.toHaveBeenCalled();
  render(noSessions, true);
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
  const saved = save.mock.calls.at(-1)![0];
  expect(saved).toHaveLength(2);
  expect(saved[0]).toMatchObject({ workingDir: '/live', launchSnapshotId: 'protected-live', toolSessionId: 'native-live' });
  expect(saved[0]).not.toHaveProperty('env');
  expect(saved[1]).toEqual({ ...failed, restorePending: true });
  render(noSessions, true);
  expect(save).toHaveBeenLastCalledWith([{ ...failed, restorePending: true }], 0, undefined);
  act(() => controls.forgetFailedSessions());
  expect(save).toHaveBeenLastCalledWith([], 0, undefined);
});

it('requires confirmation to forget failed entries from a recovery notification', async () => {
  render();
  const saved = { workingDir: '/repo', label: 'Saved', launchSnapshotId: 'protected-1' };
  act(() => controls.reportRestoreFailures([{ label: saved.label, error: 'Keychain unavailable', saved }]));
  render(noSessions, true);
  const notice = notify.mock.calls.at(-1)![0];
  expect(notice.title).toBe('Failed to restore Saved');
  expect(notice.message).toContain('retried');
  await act(async () => notice.action.onClick());
  expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ danger: true }));
  expect(save).toHaveBeenLastCalledWith([{ ...saved, restorePending: true }], 0, undefined);
  confirm.mockResolvedValueOnce({ confirmed: true, checkboxValue: false });
  await act(async () => notice.action.onClick());
  expect(save).toHaveBeenLastCalledWith([], 0, undefined);
});

it('reattaches pending entries after a renderer reload without retaining live rows twice', () => {
  render();
  act(() => controls.retainPendingRestores([{ workingDir: '/live', label: 'Live' }]));
  expect(notify).not.toHaveBeenCalled();
  const pending = { workingDir: '/failed', label: 'Failed', launchSnapshotId: 'opaque', restorePending: true };
  act(() => controls.retainPendingRestores([{ workingDir: '/live', label: 'Live' }, pending]));
  render(noSessions, true);
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
  expect(save.mock.calls.at(-1)![0]).toHaveLength(2);
});
