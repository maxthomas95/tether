import { ipcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';

export function isTrustedSender(win: BrowserWindow, event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return !win.isDestroyed() && event.sender === win.webContents &&
    event.senderFrame !== null && event.senderFrame === win.webContents.mainFrame;
}

/** Every privileged channel is scoped to the app's main frame, including on(). */
export function createTrustedIpc(win: BrowserWindow) {
  return {
    handle(channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void {
      ipcMain.handle(channel, (event, ...args) => {
        if (!isTrustedSender(win, event)) throw new Error('IPC must come from the Tether window.');
        return listener(event, ...args);
      });
    },
    on(channel: string, listener: Parameters<typeof ipcMain.on>[1]): void {
      ipcMain.on(channel, (event, ...args) => {
        if (isTrustedSender(win, event)) listener(event, ...args);
      });
    },
  };
}
