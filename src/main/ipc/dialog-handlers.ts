import { createTrustedIpc } from './trusted-ipc';
import { dialog } from 'electron';
import { IPC } from '../../shared/constants';
import type { HandlerContext } from './helpers';

export function registerDialogHandlers(ctx: HandlerContext): void {
  const ipc = createTrustedIpc(ctx.mainWindow);
  const { mainWindow } = ctx;

  ipc.handle(IPC.DIALOG_OPEN_DIRECTORY, async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Select working directory',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipc.handle(IPC.SCAN_REPOS_DIR, async (_event, dir: string) => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      return entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => path.join(dir, e.name))
        .sort();
    } catch {
      return [];
    }
  });
}
