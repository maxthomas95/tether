import { createTrustedIpc } from './trusted-ipc';
import { IPC } from '../../shared/constants';
import type { HandlerContext } from './helpers';
import { cancelPipComments } from '../pip/comment-service';
import { PIP_SETTINGS_KEY } from '../../shared/pip';
import { decryptSecretFromStorage, encryptSecretForStorage } from '../db/secret-storage';

export { SECRET_CONFIG_KEYS, isSecretConfigValue } from '../db/secret-storage';
import { isSecretConfigValue } from '../db/secret-storage';

export function encryptConfigValue(key: string, value: string): string {
  return isSecretConfigValue(key, value)
    ? encryptSecretForStorage(value, `setting ${key}`)
    : value;
}

export function decryptConfigValue(key: string, value: string): string {
  return isSecretConfigValue(key, value)
    ? decryptSecretFromStorage(value, `setting ${key}`)
    : value;
}

export function registerConfigHandlers(ctx: HandlerContext): void {
  const ipc = createTrustedIpc(ctx.mainWindow);
  const { mainWindow } = ctx;

  // === Generic config get/set ===

  ipc.handle(IPC.CONFIG_GET, async (_event, key: string) => {
    if (key === 'vaultToken') throw new Error('Vault tokens are private to the main process');
    const { getDb } = await import('../db/database');
    const value = getDb().config[key];
    return value === undefined ? null : decryptConfigValue(key, value);
  });

  ipc.handle(IPC.CONFIG_SET, async (_event, key: string, value: string) => {
    if (/^vault(?:Enabled|Addr|Role|Mount|Namespace|Token|Identity)/.test(key)) throw new Error('Use Vault settings to change Vault configuration');
    const { getDb, saveDb } = await import('../db/database');
    getDb().config[key] = encryptConfigValue(key, value);
    saveDb();
    if (key === PIP_SETTINGS_KEY) cancelPipComments();
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

  ipc.handle(IPC.CONFIG_GET_DEFAULT_CLI_FLAGS, async () => {
    const { getDb } = await import('../db/database');
    return getDb().defaultCliFlags;
  });

  ipc.handle(IPC.CONFIG_SET_DEFAULT_CLI_FLAGS, async (_event, flags: string[]) => {
    const { getDb, saveDb } = await import('../db/database');
    getDb().defaultCliFlags = flags;
    saveDb();
  });

  ipc.handle(IPC.CONFIG_GET_DEFAULT_CLI_FLAGS_PER_TOOL, async () => {
    const { getDb } = await import('../db/database');
    return getDb().defaultCliFlagsPerTool;
  });

  ipc.handle(IPC.CONFIG_SET_DEFAULT_CLI_FLAGS_FOR_TOOL, async (_event, toolId: string, flags: string[]) => {
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

  ipc.handle(IPC.CONFIG_GET_DEFAULT_ENV_VARS, async () => {
    const { getDb } = await import('../db/database');
    const { decryptEnvVarsRecord } = await import('../db/secret-storage');
    return decryptEnvVarsRecord(getDb().defaultEnvVars);
  });

  ipc.handle(IPC.CONFIG_SET_DEFAULT_ENV_VARS, async (_event, vars: Record<string, string>) => {
    const { getDb, saveDb } = await import('../db/database');
    const { encryptEnvVarsRecord } = await import('../db/secret-storage');
    getDb().defaultEnvVars = encryptEnvVarsRecord(vars);
    saveDb();
  });

  // === Repo group preferences ===

  ipc.handle(IPC.REPOGROUP_GET_PREFS, async () => {
    const { getDb } = await import('../db/database');
    return getDb().repoGroupPrefs;
  });

  ipc.handle(IPC.REPOGROUP_SET_PREFS, async (_event, environmentId: string, prefs: Array<{ environmentId: string; workingDir: string; pinned: boolean; sortOrder: number }>) => {
    const { getDb, saveDb } = await import('../db/database');
    const db = getDb();
    db.repoGroupPrefs = [
      ...db.repoGroupPrefs.filter(p => p.environmentId !== environmentId),
      ...prefs,
    ];
    saveDb();
  });

  // === Session order preferences (within a repo group) ===

  ipc.handle(IPC.SESSIONORDER_GET_PREFS, async () => {
    const { getDb } = await import('../db/database');
    return getDb().sessionOrderPrefs;
  });

  ipc.handle(IPC.SESSIONORDER_SET_PREF, async (_event, environmentId: string, workingDir: string, orderedIds: string[]) => {
    const { getDb, saveDb } = await import('../db/database');
    const db = getDb();
    db.sessionOrderPrefs = [
      ...db.sessionOrderPrefs.filter(p => !(p.environmentId === environmentId && p.workingDir === workingDir)),
      { environmentId, workingDir, orderedIds },
    ];
    saveDb();
  });

  // === Titlebar overlay ===

  ipc.handle(IPC.TITLEBAR_UPDATE, async (_event, color: string, symbolColor: string) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.setTitleBarOverlay({ color, symbolColor, height: 36 });
    }
  });
}
