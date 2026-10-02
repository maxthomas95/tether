import { IPC } from '../../shared/constants';
import type { CaptureWorkspaceRecipe, PrepareWorkspaceRecipe } from '../../shared/workspace-recipes';
import { createTrustedIpc } from './trusted-ipc';
import type { HandlerContext } from './helpers';
import {
  captureWorkspaceRecipe,
  deleteWorkspaceRecipe,
  listWorkspaceRecipes,
  prepareOpenWorkspaceRecipe,
  renameWorkspaceRecipe,
} from '../workspace-recipes/service';

export function registerWorkspaceRecipesHandlers(ctx: HandlerContext): void {
  const ipc = createTrustedIpc(ctx.mainWindow);
  ipc.handle(IPC.WORKSPACE_RECIPES_LIST, async () => listWorkspaceRecipes());
  ipc.handle(IPC.WORKSPACE_RECIPES_CAPTURE, async (_event, options: CaptureWorkspaceRecipe) => captureWorkspaceRecipe(options));
  ipc.handle(IPC.WORKSPACE_RECIPES_RENAME, async (_event, id: string, name: string) => renameWorkspaceRecipe(id, name));
  ipc.handle(IPC.WORKSPACE_RECIPES_DELETE, async (_event, id: string) => deleteWorkspaceRecipe(id));
  ipc.handle(IPC.WORKSPACE_RECIPES_PREPARE_OPEN, async (_event, options: PrepareWorkspaceRecipe) => prepareOpenWorkspaceRecipe(options));
}

