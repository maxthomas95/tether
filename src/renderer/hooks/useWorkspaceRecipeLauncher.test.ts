// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SessionInfo, TetherAPI } from '../../shared/types';
import type { WorkspaceRecipeOpenPlan } from '../../shared/workspace-recipes';
import { useWorkspaceRecipeLauncher } from './useWorkspaceRecipeLauncher';

let root: Root;
let controls: ReturnType<typeof useWorkspaceRecipeLauncher>;
const create = vi.fn();
const vaultPreflight = vi.fn();
const registerSession = vi.fn();
const requestVaultLogin = vi.fn();
const plan: WorkspaceRecipeOpenPlan = {
  recipeId: 'recipe', name: 'Work', sessionCount: 2,
  layout: { mode: 'split', activeSessionIndex: 0, split: null },
  sessions: [0, 1].map(sessionIndex => ({ sessionIndex, options: {
    label: `Slot ${sessionIndex}`, workingDir: '/repo', cliTool: 'codex', launchSnapshotId: `protected-${sessionIndex}`,
  } })),
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.electronAPI = { session: { create, vaultPreflight } } as unknown as TetherAPI;
  create.mockReset().mockImplementation(async options => ({ id: `new-${options.label}`, ...options }));
  vaultPreflight.mockReset().mockResolvedValue({ needsLogin: false });
  registerSession.mockReset();
  requestVaultLogin.mockReset().mockResolvedValue(true);
  root = createRoot(document.createElement('div'));
  function Fixture() { controls = useWorkspaceRecipeLauncher({ registerSession, requestVaultLogin }); return null; }
  act(() => root.render(createElement(Fixture)));
});
afterEach(() => { act(() => root.unmount()); });

it('launches only prepared metadata, registers successes and maintains original slot indexes', async () => {
  let result!: Awaited<ReturnType<typeof controls.launch>>;
  await act(async () => { result = await controls.launch(plan); });
  expect(result.sessionIds).toEqual(['new-Slot 0', 'new-Slot 1']);
  expect(result.failures).toEqual([]);
  expect(registerSession).toHaveBeenCalledTimes(2);
  expect(create.mock.calls.map(([options]) => options)).toEqual(plan.sessions.map(slot => slot.options));
  expect(controls.busy).toBe(false);
});

it('retains successful slots after transport failures and retries only missing sessions', async () => {
  create.mockRejectedValueOnce(new Error('Connection refused'));
  let result!: Awaited<ReturnType<typeof controls.launch>>;
  await act(async () => { result = await controls.launch(plan); });
  expect(result.sessionIds).toEqual([null, 'new-Slot 1']);
  expect(result.failures).toEqual([{ sessionIndex: 0, label: 'Slot 0', error: 'Connection refused' }]);
  create.mockClear();
  await act(async () => { result = await controls.launch(plan, result.sessionIds); });
  expect(create).toHaveBeenCalledTimes(1);
  expect(create).toHaveBeenCalledWith(plan.sessions[0].options);
  expect(result.sessionIds).toEqual(['new-Slot 0', 'new-Slot 1']);
});

it('cancels future starts while registering an in-flight successful creation and rejects concurrent launches', async () => {
  const pending = deferred<SessionInfo>();
  create.mockImplementationOnce(() => pending.promise);
  let launching!: ReturnType<typeof controls.launch>;
  await act(async () => { launching = controls.launch(plan); });
  expect(controls.busy).toBe(true);
  await expect(controls.launch(plan)).rejects.toThrow('already opening');
  controls.cancel();
  let result!: Awaited<typeof launching>;
  await act(async () => { pending.resolve({ id: 'in-flight' } as SessionInfo); result = await launching; });
  expect(create).toHaveBeenCalledTimes(1);
  expect(registerSession).toHaveBeenCalledWith({ id: 'in-flight' });
  expect(result).toMatchObject({ cancelled: true, sessionIds: ['in-flight', null] });
});

it('waits for Vault login and cancels cleanly when the prompt is dismissed', async () => {
  vaultPreflight.mockResolvedValue({ needsLogin: true, reason: 'profile' });
  requestVaultLogin.mockResolvedValue(false);
  let result!: Awaited<ReturnType<typeof controls.launch>>;
  await act(async () => { result = await controls.launch(plan); });
  expect(requestVaultLogin).toHaveBeenCalledWith('profile');
  expect(create).not.toHaveBeenCalled();
  expect(result.cancelled).toBe(true);
  requestVaultLogin.mockResolvedValue(true);
  await act(async () => { result = await controls.launch(plan); });
  expect(result.cancelled).toBe(false);
  expect(create).toHaveBeenCalledTimes(2);
});

it('fails closed on preflight errors and honors cancellation before a preflight resolves', async () => {
  vaultPreflight.mockRejectedValueOnce(new Error('Saved settings unavailable'));
  let result!: Awaited<ReturnType<typeof controls.launch>>;
  await act(async () => { result = await controls.launch({ ...plan, sessions: [plan.sessions[0]] }); });
  expect(result.failures[0].error).toBe('Saved settings unavailable');
  expect(create).not.toHaveBeenCalled();
  const pending = deferred<{ needsLogin: boolean }>();
  vaultPreflight.mockImplementationOnce(() => pending.promise);
  let launching!: ReturnType<typeof controls.launch>;
  await act(async () => { launching = controls.launch(plan); });
  controls.cancel();
  await act(async () => { pending.resolve({ needsLogin: false }); result = await launching; });
  expect(result.cancelled).toBe(true);
  expect(create).not.toHaveBeenCalled();
});

it('stops future launches after unmount without abandoning the pending process', async () => {
  const pending = deferred<SessionInfo>();
  create.mockImplementationOnce(() => pending.promise);
  let launching!: ReturnType<typeof controls.launch>;
  await act(async () => { launching = controls.launch(plan); });
  act(() => root.unmount());
  pending.resolve({ id: 'survives-unmount' } as SessionInfo);
  const result = await launching;
  expect(registerSession).toHaveBeenCalledWith({ id: 'survives-unmount' });
  expect(create).toHaveBeenCalledTimes(1);
  expect(result.cancelled).toBe(true);
});
