// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { EnvironmentInfo } from '../../shared/types';
import { useEnvironmentActions } from './useEnvironmentActions';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const existing: EnvironmentInfo = { id: 'vm', name: 'VM', type: 'ssh', config: { host: 'old.invalid' }, envVars: {}, sessionCount: 0 };
const create = vi.fn();
const update = vi.fn();
const notifyError = vi.fn();
let root: Root;
let container: HTMLDivElement;
let actions: ReturnType<typeof useEnvironmentActions>;
let environments: EnvironmentInfo[];

function Harness() {
  const [envs, setEnvs] = useState<EnvironmentInfo[]>([existing]);
  environments = envs;
  actions = useEnvironmentActions(setEnvs, notifyError);
  return null;
}

beforeEach(async () => {
  vi.stubGlobal('electronAPI', { environment: { create, update } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => { root.render(createElement(Harness)); });
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  create.mockReset();
  update.mockReset();
  notifyError.mockReset();
});

it('adds a created environment and reports success', async () => {
  const added: EnvironmentInfo = { id: 'new', name: 'New', type: 'local', config: {}, envVars: {}, sessionCount: 0 };
  create.mockResolvedValue(added);
  let ok = false;
  await act(async () => { ok = await actions.handleCreateEnvironment('New', 'local', {}, {}); });
  expect(ok).toBe(true);
  expect(create).toHaveBeenCalledWith({ name: 'New', type: 'local', config: {}, envVars: {} });
  expect(environments).toEqual([existing, added]);
  expect(notifyError).not.toHaveBeenCalled();
});

it('reports a failed create without touching the list', async () => {
  const err = new Error('disk full');
  create.mockRejectedValue(err);
  let ok = true;
  await act(async () => { ok = await actions.handleCreateEnvironment('New', 'local', {}, {}); });
  expect(ok).toBe(false);
  expect(environments).toEqual([existing]);
  expect(notifyError).toHaveBeenCalledWith('Failed to create environment', err);
});

it('applies a saved update and reports success', async () => {
  update.mockResolvedValue(undefined);
  let ok = false;
  await act(async () => { ok = await actions.handleUpdateEnvironment('vm', 'VM 2', 'ssh', { host: 'new.invalid' }, { A: '1' }); });
  expect(ok).toBe(true);
  expect(update).toHaveBeenCalledWith('vm', { name: 'VM 2', type: 'ssh', config: { host: 'new.invalid' }, envVars: { A: '1' } });
  expect(environments).toEqual([{ ...existing, name: 'VM 2', config: { host: 'new.invalid' }, envVars: { A: '1' } }]);
});

it('reports a failed update and keeps the old values', async () => {
  const err = new Error('locked');
  update.mockRejectedValue(err);
  let ok = true;
  await act(async () => { ok = await actions.handleUpdateEnvironment('vm', 'VM 2', 'ssh', {}, {}); });
  expect(ok).toBe(false);
  expect(environments).toEqual([existing]);
  expect(notifyError).toHaveBeenCalledWith('Failed to update environment', err);
});
