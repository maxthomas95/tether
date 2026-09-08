// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { EnvironmentInfo, SessionInfo } from '../../shared/types';
import { useRecentProjects } from './useRecentProjects';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const environments: EnvironmentInfo[] = [
  { id: 'local', name: 'Local', type: 'local', config: {}, envVars: {}, sessionCount: 0 },
  { id: 'ssh', name: 'Remote', type: 'ssh', config: {}, envVars: {}, sessionCount: 0 },
  { id: 'coder', name: 'Coder', type: 'coder', config: {}, envVars: {}, sessionCount: 0 },
];
const session: SessionInfo = {
  id: 'one', environmentId: 'local', workingDir: '/project', label: 'Agent',
  state: 'running', createdAt: '2026-09-07T00:00:00Z',
};
const get = vi.fn();
const set = vi.fn();
let root: Root;
let container: HTMLDivElement;
let recent: ReturnType<typeof useRecentProjects>;

function Harness(props: { sessions: SessionInfo[]; envs: EnvironmentInfo[] }) {
  recent = useRecentProjects(props.sessions, props.envs);
  return null;
}

async function render(sessions: SessionInfo[] = [], envs = environments) {
  await act(async () => { root.render(createElement(Harness, { sessions, envs })); });
}

beforeEach(() => {
  get.mockResolvedValue(null);
  set.mockResolvedValue(undefined);
  vi.stubGlobal('electronAPI', { config: { get, set } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

it('records new locations once, not on every session status change', async () => {
  await render([session]);
  expect(recent).toEqual([{ environmentId: 'local', workingDir: '/project' }]);
  expect(set).toHaveBeenCalledTimes(1);
  await render([{ ...session, state: 'waiting' }]);
  expect(set).toHaveBeenCalledTimes(1);
  await render([session, { ...session, id: 'two', environmentId: 'ssh' }]);
  expect(recent).toEqual([
    { environmentId: 'ssh', workingDir: '/project' },
    { environmentId: 'local', workingDir: '/project' },
  ]);
});

it('waits for environments and resolves legacy local sessions', async () => {
  await render([{ ...session, environmentId: null }], []);
  expect(set).not.toHaveBeenCalled();
  await render([{ ...session, environmentId: null }]);
  expect(recent).toEqual([{ environmentId: 'local', workingDir: '/project' }]);
});

it('hides deleted environments and Coder locations that cannot reopen by directory', async () => {
  get.mockResolvedValue(JSON.stringify([
    { environmentId: 'deleted', workingDir: '/old' },
    { environmentId: 'coder', workingDir: '/workspace' },
    { environmentId: 'local', workingDir: '/safe' },
  ]));
  await render([{ ...session, environmentId: 'coder' }]);
  expect(recent).toEqual([{ environmentId: 'local', workingDir: '/safe' }]);
  expect(set).not.toHaveBeenCalled();
});

it('keeps the home usable if preference storage is unavailable', async () => {
  get.mockRejectedValue(new Error('Unavailable'));
  set.mockRejectedValue(new Error('Unavailable'));
  await render([session]);
  expect(recent).toEqual([{ environmentId: 'local', workingDir: '/project' }]);
});
