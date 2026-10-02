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
const noSessions: SessionInfo[] = [];

function Fixture({ sessions, ready }: { sessions: SessionInfo[]; ready: boolean }) {
  controls = useWorkspacePersistence(sessions, sessions[0]?.id ?? null, undefined, ready);
  return null;
}

function render(sessions = noSessions, ready = false) {
  act(() => root.render(createElement(Fixture, { sessions, ready })));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.electronAPI = { workspace: { save } } as unknown as TetherAPI;
  save.mockClear();
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
