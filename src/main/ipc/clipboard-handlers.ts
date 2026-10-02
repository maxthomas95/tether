import { clipboard, ipcMain } from 'electron';
import { IPC } from '../../shared/constants';
import type { HandlerContext } from './helpers';

export function registerClipboardHandlers({ mainWindow }: HandlerContext): void {
  ipcMain.handle(IPC.CLIPBOARD_WRITE_TEXT, (event, text: unknown) => {
    if (mainWindow.isDestroyed() || event.sender !== mainWindow.webContents
      || event.senderFrame !== mainWindow.webContents.mainFrame) {
      throw new Error('Clipboard writes must come from the Tether window.');
    }
    if (typeof text !== 'string') return;
    clipboard.writeText(text);
  });
}
