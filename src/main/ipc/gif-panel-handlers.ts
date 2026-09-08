import { dialog, ipcMain } from 'electron';
import { IPC } from '../../shared/constants';
import { getDb, saveDb } from '../db/database';
import { GifPanelService } from '../gif-panel/gif-panel-service';
import type { HandlerContext } from './helpers';

export function registerGifPanelHandlers({ mainWindow }: HandlerContext): void {
  let saved: unknown;
  try { saved = JSON.parse(getDb().config.gifPanel || 'null'); } catch { /* Use defaults for malformed preferences. */ }
  const service = new GifPanelService(saved, settings => {
    const db = getDb();
    const previous = db.config.gifPanel;
    db.config.gifPanel = JSON.stringify(settings);
    try { saveDb(); } catch (error) {
      if (previous === undefined) delete db.config.gifPanel;
      else db.config.gifPanel = previous;
      throw error;
    }
  });

  const handle = (channel: string, callback: (...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
        throw new Error('GIF panel requests must come from the main window.');
      }
      return callback(...args);
    });
  };

  handle(IPC.GIF_PANEL_GET_SETTINGS, () => service.getSettings());
  handle(IPC.GIF_PANEL_UPDATE_SETTINGS, patch => service.updateSettings(patch));
  handle(IPC.GIF_PANEL_ADD_SOURCES, async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Add GIF folders',
      buttonLabel: 'Add folders',
      properties: ['openDirectory', 'multiSelections'],
    });
    return result.canceled ? service.getSettings() : service.addSources(result.filePaths);
  });
  handle(IPC.GIF_PANEL_REMOVE_SOURCE, source => service.removeSource(source));
  handle(IPC.GIF_PANEL_GET_LIBRARY, () => service.getLibrary());
  handle(IPC.GIF_PANEL_READ_IMAGE, id => service.readImage(id));
}
