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
let saved: Map<string, string>;
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
  saved = new Map();
  get.mockImplementation(async (key: string) => saved.get(key) ?? null);
  set.mockImplementation(async (key: string, value: string) => { saved.set(key, value); });
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
  expect(recent.recentProjects).toEqual([{ environmentId: 'local', workingDir: '/project' }]);
  expect(set).toHaveBeenCalledTimes(1);
  await render([{ ...session, state: 'waiting' }]);
  expect(set).toHaveBeenCalledTimes(1);
  await render([session, { ...session, id: 'two', environmentId: 'ssh' }]);
  expect(recent.recentProjects).toEqual([
    { environmentId: 'ssh', workingDir: '/project' },
    { environmentId: 'local', workingDir: '/project' },
  ]);
});

it('waits for environments and resolves legacy local sessions', async () => {
  await render([{ ...session, environmentId: null }], []);
  expect(set).not.toHaveBeenCalled();
  await render([{ ...session, environmentId: null }]);
  expect(recent.recentProjects).toEqual([{ environmentId: 'local', workingDir: '/project' }]);
});

it('hides deleted environments and Coder locations that cannot reopen by directory', async () => {
  saved.set('uiRecentProjects', JSON.stringify([
    { environmentId: 'deleted', workingDir: '/old' },
    { environmentId: 'coder', workingDir: '/workspace' },
    { environmentId: 'local', workingDir: '/safe' },
  ]));
  await render([{ ...session, environmentId: 'coder' }]);
  expect(recent.recentProjects).toEqual([{ environmentId: 'local', workingDir: '/safe' }]);
  expect(set).not.toHaveBeenCalled();
});

it('keeps the home usable if preference storage is unavailable', async () => {
  get.mockRejectedValue(new Error('Unavailable'));
  set.mockRejectedValue(new Error('Unavailable'));
  await render([session]);
  expect(recent.recentProjects).toEqual([{ environmentId: 'local', workingDir: '/project' }]);
});

it('removes only the chosen environment and keeps it dismissed across updates and restores', async () => {
  const local = { environmentId: 'local', workingDir: '/project' };
  const remote = { ...local, environmentId: 'ssh' };
  const sessions = [session, { ...session, id: 'two', environmentId: 'ssh' }];
  await render(sessions);
  await act(async () => recent.dismissProject(local));
  expect(recent.recentProjects).toEqual([remote]);
  expect(JSON.parse(saved.get('uiRecentProjects')!)).toEqual([remote]);
  expect(JSON.parse(saved.get('uiDismissedRecentProjects')!)).toEqual([local]);

  await render(sessions.map(row => ({ ...row, state: 'waiting' })));
  expect(recent.recentProjects).toEqual([remote]);
  await act(async () => root.unmount());
  root = createRoot(container);
  // Workspace restore starts fresh processes with new IDs; these are not explicit launches.
  await render(sessions.map(row => ({ ...row, id: `restored-${row.id}` })));
  expect(recent.recentProjects).toEqual([remote]);

  const reopened = { ...session, id: 'reopened' };
  recent.recordSession(reopened.id);
  await render([reopened]);
  expect(recent.recentProjects).toEqual([local, remote]);
  expect(JSON.parse(saved.get('uiDismissedRecentProjects')!)).toEqual([]);
  expect(JSON.parse(saved.get('uiRecentProjects')!)).toEqual([local, remote]);
});

it('retains more than six dismissals and handles quick consecutive removals', async () => {
  const dismissed = Array.from({ length: 8 }, (_, i) => ({ environmentId: 'local', workingDir: `/hidden/${i}` }));
  saved.set('uiDismissedRecentProjects', JSON.stringify(dismissed));
  await render([
    ...dismissed.map((row, i) => ({ ...session, ...row, id: `hidden-${i}` })),
    session, { ...session, id: 'two', workingDir: '/other' },
  ]);
  expect(recent.recentProjects).toHaveLength(2);
  const visible = recent.recentProjects;
  await act(async () => { visible.forEach(recent.dismissProject); });
  expect(recent.recentProjects).toEqual([]);
  expect(JSON.parse(saved.get('uiRecentProjects')!)).toEqual([]);
  expect(JSON.parse(saved.get('uiDismissedRecentProjects')!)).toHaveLength(10);
});

it('honors dismissals even if an old recent list still contains the location', async () => {
  const project = { environmentId: 'local', workingDir: '/project' };
  saved.set('uiRecentProjects', JSON.stringify([project]));
  saved.set('uiDismissedRecentProjects', JSON.stringify([project]));
  await render([session]);
  expect(recent.recentProjects).toEqual([]);
  expect(set).not.toHaveBeenCalled();
});
