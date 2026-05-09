import { ipcMain } from 'electron';
import { IPC } from '../../shared/constants';
import type {
  CoderWorkspace,
  CoderTemplate,
  CoderTemplateParam,
  CreateCoderWorkspaceOptions,
} from '../../shared/types';
import { createCoderWorkspace, listCoderWorkspaces, listCoderTemplates, getCoderTemplateParams } from '../coder/workspace-service';
import type { HandlerContext } from './helpers';

export function registerCoderHandlers(ctx: HandlerContext): void {
  const { send } = ctx;

  ipcMain.handle(IPC.CODER_LIST_WORKSPACES, async (_event, environmentId: string): Promise<CoderWorkspace[]> => {
    return listCoderWorkspaces(environmentId);
  });

  ipcMain.handle(IPC.CODER_LIST_TEMPLATES, async (_event, environmentId: string): Promise<CoderTemplate[]> => {
    return listCoderTemplates(environmentId);
  });

  ipcMain.handle(IPC.CODER_GET_TEMPLATE_PARAMS, async (_event, environmentId: string, templateVersionId: string): Promise<CoderTemplateParam[]> => {
    return getCoderTemplateParams(environmentId, templateVersionId);
  });

  ipcMain.handle(IPC.CODER_CREATE_WORKSPACE, async (_event, opts: CreateCoderWorkspaceOptions): Promise<CoderWorkspace> => {
    return createCoderWorkspace(opts, (line) => send(IPC.CODER_CREATE_PROGRESS, line));
  });
}
