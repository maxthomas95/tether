import { ipcMain } from 'electron';
import { IPC } from '../../shared/constants';
import type { HandlerContext } from './helpers';

export function registerConfigHandlers(ctx: HandlerContext): void {
  const { mainWindow } = ctx;

  // === Generic config get/set ===

  ipcMain.handle(IPC.CONFIG_GET, async (_event, key: string) => {
    const { getDb } = await import('../db/database');
    return getDb().config[key] ?? null;
  });

  ipcMain.handle(IPC.CONFIG_SET, async (_event, key: string, value: string) => {
    const { getDb, saveDb } = await import('../db/database');
    getDb().config[key] = value;
    saveDb();
    // Forward theme changes to the docs window so it stays in sync.
    if (key === 'theme') {
      const { getDocsWindow } = await import('../index');
      const dw = getDocsWindow();
      if (dw && !dw.isDestroyed()) {
        dw.webContents.send(IPC.DOCS_THEME_CHANGED, value);
      }
    }
  });

  // === Default CLI flags (legacy flat + per-tool) ===

  ipcMain.handle(IPC.CONFIG_GET_DEFAULT_CLI_FLAGS, async () => {
    const { getDb } = await import('../db/database');
    return getDb().defaultCliFlags;
  });

  ipcMain.handle(IPC.CONFIG_SET_DEFAULT_CLI_FLAGS, async (_event, flags: string[]) => {
    const { getDb, saveDb } = await import('../db/database');
    getDb().defaultCliFlags = flags;
    saveDb();
  });

  ipcMain.handle(IPC.CONFIG_GET_DEFAULT_CLI_FLAGS_PER_TOOL, async () => {
    const { getDb } = await import('../db/database');
    return getDb().defaultCliFlagsPerTool;
  });

  ipcMain.handle(IPC.CONFIG_SET_DEFAULT_CLI_FLAGS_FOR_TOOL, async (_event, toolId: string, flags: string[]) => {
    const { getDb, saveDb } = await import('../db/database');
    const db = getDb();
    if (!db.defaultCliFlagsPerTool) db.defaultCliFlagsPerTool = {};
    if (flags.length > 0) {
      (db.defaultCliFlagsPerTool as Record<string, string[]>)[toolId] = flags;
    } else {
      delete (db.defaultCliFlagsPerTool as Record<string, string[]>)[toolId];
    }
    saveDb();
  });

  // === Default env vars ===

  ipcMain.handle(IPC.CONFIG_GET_DEFAULT_ENV_VARS, async () => {
    const { getDb } = await import('../db/database');
    const { decryptEnvVarsRecord } = await import('../db/secret-storage');
    return decryptEnvVarsRecord(getDb().defaultEnvVars);
  });

  ipcMain.handle(IPC.CONFIG_SET_DEFAULT_ENV_VARS, async (_event, vars: Record<string, string>) => {
    const { getDb, saveDb } = await import('../db/database');
    const { encryptEnvVarsRecord } = await import('../db/secret-storage');
    getDb().defaultEnvVars = encryptEnvVarsRecord(vars);
    saveDb();
  });

  // === Repo group preferences ===

  ipcMain.handle(IPC.REPOGROUP_GET_PREFS, async () => {
    const { getDb } = await import('../db/database');
    return getDb().repoGroupPrefs;
  });

  ipcMain.handle(IPC.REPOGROUP_SET_PREFS, async (_event, environmentId: string, prefs: Array<{ environmentId: string; workingDir: string; pinned: boolean; sortOrder: number }>) => {
    const { getDb, saveDb } = await import('../db/database');
    const db = getDb();
    db.repoGroupPrefs = [
      ...db.repoGroupPrefs.filter(p => p.environmentId !== environmentId),
      ...prefs,
    ];
    saveDb();
  });

  // === Session order preferences (within a repo group) ===

  ipcMain.handle(IPC.SESSIONORDER_GET_PREFS, async () => {
    const { getDb } = await import('../db/database');
    return getDb().sessionOrderPrefs;
  });

  ipcMain.handle(IPC.SESSIONORDER_SET_PREF, async (_event, environmentId: string, workingDir: string, orderedIds: string[]) => {
    const { getDb, saveDb } = await import('../db/database');
    const db = getDb();
    db.sessionOrderPrefs = [
      ...db.sessionOrderPrefs.filter(p => !(p.environmentId === environmentId && p.workingDir === workingDir)),
      { environmentId, workingDir, orderedIds },
    ];
    saveDb();
  });

  // === Titlebar overlay ===

  ipcMain.handle(IPC.TITLEBAR_UPDATE, async (_event, color: string, symbolColor: string) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.setTitleBarOverlay({ color, symbolColor, height: 36 });
    }
  });
}
