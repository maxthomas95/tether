import { describe, expect, it, beforeEach, vi } from 'vitest';
import { createHarness, makeElectronMockBase, type IpcRegistry } from './ipc-test-harness.test-helper';

const registry = vi.hoisted<IpcRegistry>(() => ({ handlers: new Map(), listeners: new Map() }));
vi.mock('electron', () => makeElectronMockBase(registry));

const service = vi.hoisted(() => ({
  listWorkspaceRecipes: vi.fn(),
  captureWorkspaceRecipe: vi.fn(),
  renameWorkspaceRecipe: vi.fn(),
  deleteWorkspaceRecipe: vi.fn(),
  prepareOpenWorkspaceRecipe: vi.fn(),
}));

vi.mock('../workspace-recipes/service', () => service);

import { IPC } from '../../shared/constants';
import { registerWorkspaceRecipesHandlers } from './workspace-recipes-handlers';

const harness = createHarness(registry);

describe('workspace recipe IPC handlers', () => {
  beforeEach(() => {
    harness.reset();
    Object.values(service).forEach(fn => fn.mockReset());
    registerWorkspaceRecipesHandlers(harness.ctx);
  });

  it('registers list, capture, rename, delete, and prepare-open handlers', async () => {
    service.listWorkspaceRecipes.mockReturnValueOnce([{ id: 'r1' }]);
    await expect(harness.invoke(IPC.WORKSPACE_RECIPES_LIST)).resolves.toEqual([{ id: 'r1' }]);

    const capture = { name: 'Recipe', sessionIds: ['s1'], layout: { mode: 'split', activeSessionIndex: 0, split: { type: 'leaf', sessionIndex: 0 } } };
    service.captureWorkspaceRecipe.mockReturnValueOnce({ id: 'created' });
    await expect(harness.invoke(IPC.WORKSPACE_RECIPES_CAPTURE, capture)).resolves.toEqual({ id: 'created' });
    expect(service.captureWorkspaceRecipe).toHaveBeenCalledWith(capture);

    service.renameWorkspaceRecipe.mockReturnValueOnce({ id: 'r1', name: 'Next' });
    await expect(harness.invoke(IPC.WORKSPACE_RECIPES_RENAME, 'r1', 'Next')).resolves.toEqual({ id: 'r1', name: 'Next' });
    expect(service.renameWorkspaceRecipe).toHaveBeenCalledWith('r1', 'Next');

    service.deleteWorkspaceRecipe.mockReturnValueOnce(undefined);
    await harness.invoke(IPC.WORKSPACE_RECIPES_DELETE, 'r1');
    expect(service.deleteWorkspaceRecipe).toHaveBeenCalledWith('r1');

    const prepare = { recipeId: 'r1', selections: [{ sessionIndex: 0, workingDir: 'C:/repo/app' }] };
    service.prepareOpenWorkspaceRecipe.mockResolvedValueOnce({ ok: true, plan: { recipeId: 'r1' } });
    await expect(harness.invoke(IPC.WORKSPACE_RECIPES_PREPARE_OPEN, prepare)).resolves.toEqual({ ok: true, plan: { recipeId: 'r1' } });
    expect(service.prepareOpenWorkspaceRecipe).toHaveBeenCalledWith(prepare);
  });
});

