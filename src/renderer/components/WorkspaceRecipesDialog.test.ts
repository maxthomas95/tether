// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentInfo, SessionInfo } from '../../shared/types';
import type { PreparedWorkspaceRecipe, WorkspaceRecipe, WorkspaceRecipeLaunchResult, WorkspaceRecipeOpenPlan } from '../../shared/workspace-recipes';
import { WorkspaceRecipesDialog } from './WorkspaceRecipesDialog';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
let api: {
  list: ReturnType<typeof vi.fn>;
  rename: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  prepareOpen: ReturnType<typeof vi.fn>;
};
let props: React.ComponentProps<typeof WorkspaceRecipesDialog>;

const localEnv: EnvironmentInfo = { id: 'local-env', name: 'Local PC', type: 'local', config: {}, envVars: {}, sessionCount: 0 };
const sshEnv: EnvironmentInfo = { id: 'ssh-env', name: 'Build VM', type: 'ssh', config: {}, envVars: {}, sessionCount: 0 };
const coderEnv: EnvironmentInfo = { id: 'coder-env', name: 'Coder Dev', type: 'coder', config: {}, envVars: {}, sessionCount: 0 };

const sessions: SessionInfo[] = [
  { id: 's1', environmentId: null, label: 'Local task', workingDir: 'repo', state: 'running', createdAt: '2026-10-02T00:00:00Z', cliTool: 'codex' },
  { id: 's2', environmentId: 'ssh-env', label: 'Remote task', workingDir: 'remote/repo', state: 'idle', createdAt: '2026-10-02T00:00:01Z', cliTool: 'claude' },
];

function recipe(overrides: Partial<WorkspaceRecipe> = {}): WorkspaceRecipe {
  return {
    id: 'r1', version: 1, name: 'Daily workspace', createdAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-02T01:00:00Z',
    sessions: [
      { label: 'Local task', workingDir: 'repo', cliTool: 'codex' },
      { label: 'Remote task', workingDir: 'old-remote', environmentId: 'missing-env', cliTool: 'claude' },
    ],
    layout: { mode: 'split', activeSessionIndex: 0, split: { type: 'leaf', sessionIndex: 0 } },
    ...overrides,
  };
}

function planFor(r: WorkspaceRecipe, selectedIndexes = [0, 1]): WorkspaceRecipeOpenPlan {
  return {
    recipeId: r.id,
    name: r.name,
    sessionCount: selectedIndexes.length,
    layout: r.layout,
    sessions: selectedIndexes.map(index => ({ sessionIndex: index, options: r.sessions[index] })),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function installApi(recipes: WorkspaceRecipe[] = []) {
  api = {
    list: vi.fn().mockResolvedValue(recipes),
    rename: vi.fn(async (id: string, name: string) => ({ ...recipes.find(r => r.id === id)!, name, updatedAt: '2026-10-02T02:00:00Z' })),
    delete: vi.fn().mockResolvedValue(undefined),
    prepareOpen: vi.fn(),
  };
  vi.stubGlobal('electronAPI', { workspaceRecipes: api, homeDir: 'home' });
}

function baseProps(overrides: Partial<React.ComponentProps<typeof WorkspaceRecipesDialog>> = {}): React.ComponentProps<typeof WorkspaceRecipesDialog> {
  return {
    sessions,
    environments: [localEnv, sshEnv, coderEnv],
    launching: false,
    onClose: vi.fn(),
    onCapture: vi.fn(),
    onLaunch: vi.fn(),
    onFinish: vi.fn(),
    onCancelLaunch: vi.fn(),
    ...overrides,
  };
}

async function renderDialog(overrides: Partial<React.ComponentProps<typeof WorkspaceRecipesDialog>> = {}) {
  props = baseProps(overrides);
  await act(async () => { root.render(createElement(WorkspaceRecipesDialog, props)); });
  await act(async () => { await Promise.resolve(); });
}

function clickText(text: string) {
  const buttons = Array.from(host.querySelectorAll<HTMLButtonElement>('button'));
  const button = buttons.find(el => el.textContent?.trim() === text) ?? buttons.find(el => el.textContent?.includes(text));
  if (!button) throw new Error(`Missing button ${text}`);
  act(() => button.click());
  return button;
}

function setValue(input: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = input instanceof HTMLSelectElement ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

beforeEach(() => {
  vi.clearAllMocks();
  installApi();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('WorkspaceRecipesDialog', () => {
  it('shows an empty state and validates save selections before capture', async () => {
    const onCapture = vi.fn().mockResolvedValue(recipe({ id: 'new', name: 'Saved pair' }));
    await renderDialog({ onCapture });

    expect(host.textContent).toContain('No saved workspaces yet');
    clickText('Save this workspace');
    expect(host.textContent).toContain('2/2 selected');

    clickText('Clear');
    clickText('Save workspace');
    expect(host.textContent).toContain('Name this workspace');
    expect(onCapture).not.toHaveBeenCalled();

    const name = host.querySelector<HTMLInputElement>('input[placeholder="Daily review"]')!;
    act(() => setValue(name, 'Saved pair'));
    clickText('Save workspace');
    expect(host.textContent).toContain('Choose between 1 and 64 sessions');

    clickText('Select all');
    await act(async () => { clickText('Save workspace'); });
    expect(onCapture).toHaveBeenCalledWith('Saved pair', ['s1', 's2']);
    expect(host.textContent).toContain('Saved pair');
  });

  it('renames and deletes recipes with inline confirmation', async () => {
    installApi([recipe()]);
    await renderDialog();

    clickText('Rename');
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Workspace name"]')!;
    act(() => setValue(input, 'Renamed workspace'));
    await act(async () => { clickText('Save'); });
    expect(api.rename).toHaveBeenCalledWith('r1', 'Renamed workspace');
    expect(host.textContent).toContain('Renamed workspace');

    clickText('Delete');
    expect(host.textContent).toContain('Delete this recipe?');
    await act(async () => { clickText('Delete'); });
    expect(api.delete).toHaveBeenCalledWith('r1');
  });

  it('blocks launch when prepareOpen returns row failures', async () => {
    const saved = recipe();
    installApi([saved]);
    api.prepareOpen.mockResolvedValue({ ok: false, failures: [{ sessionIndex: 1, label: 'Remote task', error: 'Vault login required' }] } satisfies PreparedWorkspaceRecipe);
    const onLaunch = vi.fn();
    await renderDialog({ onLaunch });

    await act(async () => { clickText('Open selected sessions'); });
    expect(api.prepareOpen).toHaveBeenCalledWith({
      recipeId: 'r1',
      selections: [
        { sessionIndex: 0, workingDir: 'repo', environmentId: undefined },
        { sessionIndex: 1, workingDir: 'old-remote', environmentId: 'missing-env' },
      ],
    });
    expect(onLaunch).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Vault login required');
  });

  it('supports local remapping and shows missing environment warnings until remapped', async () => {
    const saved = recipe();
    installApi([saved]);
    const plan = planFor(saved, [1]);
    api.prepareOpen.mockResolvedValue({ ok: true, plan } satisfies PreparedWorkspaceRecipe);
    const onLaunch = vi.fn().mockResolvedValue({ sessionIds: [null, 'new-s2'], failures: [], cancelled: false } satisfies WorkspaceRecipeLaunchResult);
    const onFinish = vi.fn();
    await renderDialog({ onLaunch, onFinish });

    expect(host.textContent).toContain('Saved environment is missing');
    const checkboxes = host.querySelectorAll<HTMLInputElement>('.workspace-recipes-slot-check input');
    act(() => checkboxes[0].click());
    const selects = host.querySelectorAll<HTMLSelectElement>('.workspace-recipes-slot select');
    act(() => setValue(selects[1], ''));

    await act(async () => { clickText('Open selected sessions'); });
    expect(api.prepareOpen).toHaveBeenCalledWith({ recipeId: 'r1', selections: [{ sessionIndex: 1, workingDir: 'old-remote', environmentId: undefined }] });
    expect(onLaunch).toHaveBeenCalledWith(plan, undefined);
    expect(onFinish).toHaveBeenCalled();
  });

  it('retries partial launches without duplicating started slots', async () => {
    const saved = recipe();
    const firstPlan = planFor(saved);
    const retryPlan = planFor(saved, [1]);
    installApi([saved]);
    api.prepareOpen
      .mockResolvedValueOnce({ ok: true, plan: firstPlan } satisfies PreparedWorkspaceRecipe)
      .mockResolvedValueOnce({ ok: true, plan: retryPlan } satisfies PreparedWorkspaceRecipe);
    const partial: WorkspaceRecipeLaunchResult = { sessionIds: ['new-s1', null], failures: [{ sessionIndex: 1, label: 'Remote task', error: 'SSH offline' }], cancelled: false };
    const done: WorkspaceRecipeLaunchResult = { sessionIds: ['new-s1', 'new-s2'], failures: [], cancelled: false };
    const onLaunch = vi.fn().mockResolvedValueOnce(partial).mockResolvedValueOnce(done);
    const onFinish = vi.fn();
    await renderDialog({ onLaunch, onFinish });

    await act(async () => { clickText('Open selected sessions'); });
    expect(host.textContent).toContain('SSH offline');
    expect(host.textContent).toContain('1 started');

    await act(async () => { clickText('Start remaining selected'); });
    expect(onLaunch).toHaveBeenLastCalledWith(retryPlan, ['new-s1', null]);
    expect(onFinish).toHaveBeenLastCalledWith(retryPlan, done);
  });

  it('cancels remaining launches and respects busy or blocked states', async () => {
    const saved = recipe();
    installApi([saved]);
    api.prepareOpen.mockResolvedValue({ ok: true, plan: planFor(saved) } satisfies PreparedWorkspaceRecipe);
    const pending = deferred<WorkspaceRecipeLaunchResult>();
    const onLaunch = vi.fn(() => pending.promise);
    const onCancelLaunch = vi.fn();
    await renderDialog({ onLaunch, onCancelLaunch });

    await act(async () => { clickText('Open selected sessions'); });
    clickText('Cancel remaining');
    expect(onCancelLaunch).toHaveBeenCalledOnce();

    await act(async () => { root.render(createElement(WorkspaceRecipesDialog, baseProps({ blocked: true }))); });
    const close = host.querySelector<HTMLButtonElement>('[aria-label="Close workspaces"]')!;
    expect(close.disabled).toBe(true);
    act(() => {
      host.querySelector('[role="dialog"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(props.onClose).not.toHaveBeenCalled();
    pending.resolve({ sessionIds: [null, null], failures: [], cancelled: true });
  });

  it('closes with Escape when not blocked', async () => {
    const onClose = vi.fn();
    await renderDialog({ onClose });
    act(() => {
      host.querySelector('[role="dialog"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
