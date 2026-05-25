import { execFile } from 'node:child_process';
import { app, ipcMain, dialog, shell } from 'electron';
import { IPC } from '../../shared/constants';
import { createLogger } from '../logger';
import type { HandlerContext } from './helpers';

const log = createLogger('ipc:system');
const COMMAND_LOOKUP_TIMEOUT_MS = 3_000;

function commandExists(command: string): Promise<boolean> {
  const trimmed = command.trim();
  if (!trimmed) return Promise.resolve(false);

  return new Promise((resolve) => {
    const executable = process.platform === 'win32' ? 'where.exe' : 'sh';
    const args = process.platform === 'win32'
      ? [trimmed]
      : ['-lc', 'command -v "$1" >/dev/null 2>&1', 'sh', trimmed];

    execFile(executable, args, { timeout: COMMAND_LOOKUP_TIMEOUT_MS }, (err) => {
      resolve(!err);
    });
  });
}

export function registerSystemHandlers(ctx: HandlerContext): void {
  const { mainWindow } = ctx;

  ipcMain.handle(IPC.UPDATE_CHECK, async () => {
    const { getDb } = await import('../db/database');
    const { checkForUpdates } = await import('../update/update-checker');
    const channel = getDb().config.updateChannel === 'beta' ? 'beta' as const : 'stable' as const;
    return checkForUpdates(channel);
  });

  ipcMain.handle(IPC.UPDATE_OPEN_RELEASE_PAGE, async (_event, url: string) => {
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' || u.host !== 'github.com' || !u.pathname.startsWith('/maxthomas95/tether/')) {
        log.warn('Refusing to open non-release URL', { url });
        return;
      }
    } catch {
      log.warn('Refusing to open malformed URL', { url });
      return;
    }
    await shell.openExternal(url);
  });

  ipcMain.handle(IPC.SHELL_OPEN_EXTERNAL, async (_event, url: string) => {
    if (typeof url !== 'string' || url.length > 2048) {
      log.warn('Refusing to open URL: invalid or too long', { length: typeof url === 'string' ? url.length : -1 });
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      log.warn('Refusing to open malformed URL', { url });
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      log.warn('Refusing to open URL with disallowed protocol', { url });
      return;
    }
    await shell.openExternal(url);
  });

  ipcMain.handle(IPC.SHELL_COMMAND_EXISTS, async (_event, command: string) => {
    if (typeof command !== 'string' || command.length > 512) return false;
    return commandExists(command);
  });

  // === Diagnostics export ===

  ipcMain.handle(IPC.DIAGNOSTICS_EXPORT, async () => {
    const { exportDiagnostics, defaultExportFilename } = await import('../diagnostics/diagnostics-service');
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export diagnostics',
      defaultPath: defaultExportFilename(),
      filters: [{ name: 'Zip', extensions: ['zip'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, error: 'cancelled' };
    return exportDiagnostics(result.filePath);
  });

  ipcMain.handle(IPC.DIAGNOSTICS_OPEN_USER_DATA_FOLDER, async () => {
    const target = app.getPath('userData');
    const err = await shell.openPath(target);
    if (err) {
      log.warn('Failed to open user data folder', { target, error: err });
      return { ok: false, error: err };
    }
    return { ok: true, path: target };
  });

  ipcMain.handle(IPC.DIAGNOSTICS_OPEN_LOGS_FOLDER, async () => {
    const target = app.getPath('logs');
    const err = await shell.openPath(target);
    if (err) {
      log.warn('Failed to open logs folder', { target, error: err });
      return { ok: false, error: err };
    }
    return { ok: true, path: target };
  });
}
