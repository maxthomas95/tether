import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { IPC } from '../../shared/constants';
import { MaintenanceManager } from '../cli-maintenance/maintenance-manager';
import { maintenanceTarget } from '../cli-maintenance/maintenance-target';
import type { HandlerContext } from './helpers';

export function registerCliMaintenanceHandlers({ mainWindow, send }: HandlerContext): void {
  const manager = new MaintenanceManager(maintenanceTarget,
    (id, phase, data) => send(IPC.CLI_MAINTENANCE_DATA, id, phase, data),
    run => send(IPC.CLI_MAINTENANCE_CHANGED, run));
  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent) => !mainWindow.isDestroyed()
    && event.sender === mainWindow.webContents && event.senderFrame === mainWindow.webContents.mainFrame;
  const checkSender = (event: IpcMainEvent | IpcMainInvokeEvent) => {
    if (!trusted(event)) {
      throw new Error('CLI maintenance is only available in the Tether window.');
    }
  };
  ipcMain.handle(IPC.CLI_MAINTENANCE_START, (event, request: unknown) => { checkSender(event); return manager.start(request); });
  ipcMain.handle(IPC.CLI_MAINTENANCE_CANCEL, (event, id: string) => { checkSender(event); manager.cancel(id); });
  ipcMain.on(IPC.CLI_MAINTENANCE_INPUT, (event, id: string, data: string) => { if (trusted(event)) manager.input(id, data); });
  ipcMain.on(IPC.CLI_MAINTENANCE_RESIZE, (event, id: string, cols: number, rows: number) => { if (trusted(event)) manager.resize(id, cols, rows); });
  mainWindow.on('closed', () => manager.dispose());
  mainWindow.webContents.on('render-process-gone', () => manager.dispose());
  mainWindow.webContents.on('did-start-loading', () => manager.dispose());
}
