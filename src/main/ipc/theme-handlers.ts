import { ipcMain, shell, type BrowserWindow } from 'electron';
import { IPC } from '../../shared/constants';
import { getTheme } from '../../shared/themes';
import { getDb } from '../db/database';
import { ensureThemesDirectory, getLocalThemeCatalog, getThemesDirectory, loadLocalThemes } from '../themes/local-themes';
import { createTrustedIpc, isTrustedSender } from './trusted-ipc';
import type { HandlerContext } from './helpers';

export function registerThemeHandlers(ctx: HandlerContext, getDocsWindow: () => BrowserWindow | null): void {
  const ipc = createTrustedIpc(ctx.mainWindow);
  // Help has its own sandboxed preload and may only read the catalog.
  ipcMain.handle(IPC.THEMES_LIST, event => {
    const docs = getDocsWindow();
    if (!isTrustedSender(ctx.mainWindow, event) && !(docs && isTrustedSender(docs, event))) {
      throw new Error('IPC must come from a Tether window.');
    }
    return getLocalThemeCatalog();
  });
  ipc.handle(IPC.THEMES_RELOAD, () => {
    const catalog = loadLocalThemes();
    const docs = getDocsWindow();
    if (docs && !docs.isDestroyed()) {
      const theme = getTheme(getDb().config.theme || 'mocha');
      docs.setTitleBarOverlay({ ...theme.titlebar, height: 36 });
      docs.webContents.send(IPC.DOCS_THEME_CHANGED, theme.name, catalog.themes);
    }
    return catalog;
  });
  ipc.handle(IPC.THEMES_OPEN_FOLDER, async () => {
    ensureThemesDirectory();
    const error = await shell.openPath(getThemesDirectory());
    if (error) throw new Error(error);
  });
}
