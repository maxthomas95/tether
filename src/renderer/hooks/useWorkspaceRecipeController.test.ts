// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SessionInfo, TetherAPI } from '../../shared/types';
import type { WorkspaceRecipeOpenPlan } from '../../shared/workspace-recipes';
import { initialCanvasState } from '../lib/canvas-layout';
import { buildConstrainedLayout, getLeaves } from '../lib/layout-tree';
import { useWorkspaceRecipeController } from './useWorkspaceRecipeController';

let root: Root;
let controls: ReturnType<typeof useWorkspaceRecipeController>;
let frames: FrameRequestCallback[];
const registerSession = vi.fn();
const requestVaultLogin = vi.fn().mockResolvedValue(true);
const applyLayout = vi.fn();
const focusPane = vi.fn();
const notifyError = vi.fn();
const capture = vi.fn();
const configSet = vi.fn();
const create = vi.fn();
const plan: WorkspaceRecipeOpenPlan = {
  recipeId: 'recipe', name: 'Work', sessionCount: 2,
  layout: { mode: 'split', activeSessionIndex: 1, split: { type: 'split', direction: 'vertical', ratio: 0.5,
    children: [{ type: 'leaf', sessionIndex: 0 }, { type: 'leaf', sessionIndex: 1 }] } },
  sessions: [0, 1].map(sessionIndex => ({ sessionIndex, options: {
    label: `Slot ${sessionIndex}`, workingDir: '/repo', cliTool: 'codex', launchSnapshotId: `protected-${sessionIndex}`,
  } })),
};
function flushFrames() { while (frames.length) frames.shift()!(0); }
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  for (const mock of [registerSession, applyLayout, focusPane, notifyError, capture, configSet, create]) mock.mockReset();
  capture.mockResolvedValue({ id: 'saved' });
  configSet.mockResolvedValue(undefined);
  create.mockImplementation(async options => ({ id: `new-${options.label}`, ...options }));
  window.electronAPI = { config: { set: configSet }, workspaceRecipes: { capture },
    session: { create, vaultPreflight: vi.fn().mockResolvedValue({ needsLogin: false }) } } as unknown as TetherAPI;
  root = createRoot(document.createElement('div'));
  function Fixture() {
    controls = useWorkspaceRecipeController({
      activeSessionId: 'existing-b', splitState: { root: buildConstrainedLayout(['existing-a', 'existing-b']),
        focusedPaneId: null, maximizedPaneId: null, maxPanes: 4 }, canvasState: initialCanvasState,
      canvasEnabled: false, maxPanes: 4,
      registerSession, requestVaultLogin, applyLayout, focusPane, notifyError,
    });
    return null;
  }
  act(() => root.render(createElement(Fixture)));
});
afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });

it('captures only selected runtime ids with layouts remapped to selected slot indexes', async () => {
  act(() => controls.open());
  expect(controls.isOpen).toBe(true);
  await controls.capture('Daily', ['existing-b']);
  expect(capture).toHaveBeenCalledWith({ name: 'Daily', sessionIds: ['existing-b'], layout: {
    mode: 'split', activeSessionIndex: 0, split: { type: 'split', direction: 'horizontal', ratio: 0.5,
      children: [{ type: 'leaf', sessionIndex: null }, { type: 'leaf', sessionIndex: 0 }] },
  } });
});

it('registers launches without changing layout until finish releases the dialog and hands off focus', async () => {
  act(() => controls.open());
  let result!: Awaited<ReturnType<typeof controls.launch>>;
  await act(async () => { result = await controls.launch(plan); });
  expect(registerSession).toHaveBeenCalledTimes(2);
  expect(applyLayout).not.toHaveBeenCalled();
  expect(controls.isOpen).toBe(true);
  act(() => controls.finish(plan, result));
  expect(controls.isOpen).toBe(false);
  const opened = applyLayout.mock.calls[0][0];
  expect(getLeaves(opened.split.root).map(leaf => leaf.sessionId)).toEqual(result.sessionIds);
  expect(opened.mode).toBe('split');
  expect(configSet).toHaveBeenCalledWith('sessionLayoutMode', 'split');
  expect(focusPane).not.toHaveBeenCalled();
  flushFrames();
  expect(focusPane).toHaveBeenCalledWith(opened.split.focusedPaneId);
});

it('keeps a successful pending creation in the sidebar after Close without changing layout or focus later', async () => {
  let resolve!: (session: SessionInfo) => void;
  create.mockImplementationOnce(() => new Promise<SessionInfo>(done => { resolve = done; }));
  act(() => controls.open());
  let launching!: ReturnType<typeof controls.launch>;
  await act(async () => { launching = controls.launch(plan); });
  act(() => controls.close());
  act(() => controls.open());
  expect(controls.isOpen).toBe(false);
  let result!: Awaited<typeof launching>;
  await act(async () => { resolve({ id: 'created-after-close' } as SessionInfo); result = await launching; });
  expect(result.sessionIds).toEqual(['created-after-close', null]);
  expect(result.cancelled).toBe(true);
  expect(registerSession).toHaveBeenCalledWith({ id: 'created-after-close' });
  expect(applyLayout).not.toHaveBeenCalled();
  expect(configSet).not.toHaveBeenCalled();
  flushFrames();
  expect(focusPane).not.toHaveBeenCalled();
});

it('Close after a partial launch keeps existing layout while Show started restores successful Canvas slots', async () => {
  act(() => controls.open());
  create.mockRejectedValueOnce(new Error('Connection refused'));
  let result!: Awaited<ReturnType<typeof controls.launch>>;
  await act(async () => { result = await controls.launch(plan); });
  act(() => controls.close());
  expect(applyLayout).not.toHaveBeenCalled();
  const canvasPlan = { ...plan, layout: { ...plan.layout, mode: 'canvas' as const } };
  act(() => { controls.open(); controls.finish(canvasPlan, result); });
  const opened = applyLayout.mock.calls[0][0];
  expect(opened.sessionIds).toEqual([null, 'new-Slot 1']);
  expect(opened.canvas.panels.map((panel: { sessionIndex: number }) => panel.sessionIndex)).toEqual([1]);
  expect(opened.canvas.focusedSessionIndex).toBe(1);
  flushFrames();
  expect(focusPane).toHaveBeenCalledWith('canvas-new-Slot 1');
});

it('reports persistence failures without losing created sessions or stealing focus after another dialog opens', async () => {
  const error = new Error('Preferences unavailable');
  configSet.mockRejectedValueOnce(error);
  act(() => controls.open());
  let result!: Awaited<ReturnType<typeof controls.launch>>;
  await act(async () => { result = await controls.launch(plan); controls.finish(plan, result); });
  expect(applyLayout).toHaveBeenCalledTimes(1);
  expect(notifyError).toHaveBeenCalledWith('Could not save the layout mode', error);
  act(() => controls.open());
  flushFrames();
  expect(focusPane).not.toHaveBeenCalled();
});

it('finishes an empty cancelled attempt without replacing the current workspace', () => {
  act(() => { controls.open(); controls.finish(plan, { sessionIds: [null, null], failures: [], cancelled: true }); });
  expect(controls.isOpen).toBe(false);
  expect(applyLayout).not.toHaveBeenCalled();
  expect(configSet).not.toHaveBeenCalled();
});

it('disposes deferred focus when the controller unmounts', async () => {
  act(() => controls.open());
  let result!: Awaited<ReturnType<typeof controls.launch>>;
  await act(async () => { result = await controls.launch(plan); controls.finish(plan, result); });
  act(() => root.unmount());
  flushFrames();
  expect(focusPane).not.toHaveBeenCalled();
});
