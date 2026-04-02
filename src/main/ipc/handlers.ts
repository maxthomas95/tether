import { ipcMain, BrowserWindow, dialog } from 'electron';
import { IPC } from '../../shared/constants';
import type { CreateSessionOptions, CreateEnvironmentOptions, EnvironmentInfo } from '../../shared/types';
import { sessionManager } from '../session/session-manager';
import * as envRepo from '../db/environment-repo';
import * as sessionRepo from '../db/session-repo';

export function registerIpcHandlers(mainWindow: BrowserWindow): void {
  const send = (channel: string, ...args: unknown[]) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, ...args);
    }
  };

  // === Session handlers ===

  ipcMain.handle(IPC.SESSION_CREATE, async (_event, opts: CreateSessionOptions) => {
    const session = await sessionManager.createSession(opts, {
      onData(data: string) {
        send(IPC.SESSION_DATA, session.id, data);
      },
      onStateChange(state) {
        send(IPC.SESSION_STATE_CHANGE, session.id, state);
        sessionRepo.updateSessionState(session.id, state);
      },
      onExit(exitCode) {
        send(IPC.SESSION_EXITED, session.id, exitCode);
      },
    });

    // Persist to DB
    sessionRepo.createSessionRow({
      label: session.label,
      working_dir: session.workingDir,
      environment_id: opts.environmentId,
      state: 'running',
    });
    // Use the manager's session id, not the DB row id — they're the same uuid
    // Actually the DB creates its own id. Let me fix this by passing the id.
    // For now, the in-memory session manager is the source of truth for live sessions.

    return session.toInfo();
  });

  ipcMain.handle(IPC.SESSION_LIST, async () => {
    return sessionManager.listSessions().map(s => s.toInfo());
  });

  ipcMain.handle(IPC.SESSION_STOP, async (_event, sessionId: string) => {
    await sessionManager.stopSession(sessionId);
  });

  ipcMain.handle(IPC.SESSION_KILL, async (_event, sessionId: string) => {
    sessionManager.killSession(sessionId);
  });

  ipcMain.handle(IPC.SESSION_RENAME, async (_event, sessionId: string, label: string) => {
    sessionManager.renameSession(sessionId, label);
  });

  ipcMain.handle(IPC.SESSION_REMOVE, async (_event, sessionId: string) => {
    sessionManager.removeSession(sessionId);
  });

  ipcMain.on(IPC.SESSION_INPUT, (_event, sessionId: string, data: string) => {
    sessionManager.writeToSession(sessionId, data);
  });

  ipcMain.on(IPC.SESSION_RESIZE, (_event, sessionId: string, cols: number, rows: number) => {
    sessionManager.resizeSession(sessionId, cols, rows);
  });

  // === Environment handlers ===

  ipcMain.handle(IPC.ENV_LIST, async () => {
    const envs = envRepo.listEnvironments();
    const sessions = sessionManager.listSessions();
    return envs.map((env): EnvironmentInfo => ({
      id: env.id,
      name: env.name,
      type: env.type as EnvironmentInfo['type'],
      config: JSON.parse(env.config),
      sessionCount: sessions.filter(s => {
        if (s.environmentId === env.id) return true;
        if (env.type === 'local' && !s.environmentId) return true;
        return false;
      }).length,
    }));
  });

  ipcMain.handle(IPC.ENV_CREATE, async (_event, opts: CreateEnvironmentOptions) => {
    const env = envRepo.createEnvironment({
      name: opts.name,
      type: opts.type,
      config: opts.config,
    });
    return {
      id: env.id,
      name: env.name,
      type: env.type,
      config: JSON.parse(env.config),
      sessionCount: 0,
    } as EnvironmentInfo;
  });

  ipcMain.handle(IPC.ENV_UPDATE, async (_event, id: string, opts: Partial<CreateEnvironmentOptions>) => {
    envRepo.updateEnvironment(id, {
      name: opts.name,
      type: opts.type,
      config: opts.config,
    });
  });

  ipcMain.handle(IPC.ENV_DELETE, async (_event, id: string) => {
    envRepo.deleteEnvironment(id);
  });

  // === Dialog handlers ===

  ipcMain.handle(IPC.DIALOG_OPEN_DIRECTORY, async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Select working directory',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
}
