import { ipcMain } from 'electron';
import { IPC } from '../../shared/constants';
import type { NotificationPrefs } from '../../shared/types';
import { readPrefsFromConfig, writePrefsToConfig } from '../notifications/notification-service';
import { sessionManager } from '../session/session-manager';
import type { HandlerContext } from './helpers';

export function registerNotificationsHandlers(_ctx: HandlerContext): void {
  ipcMain.handle(IPC.NOTIFICATIONS_GET_PREFS, async (): Promise<NotificationPrefs> => {
    const { getDb } = await import('../db/database');
    return readPrefsFromConfig(getDb().config);
  });

  ipcMain.handle(IPC.NOTIFICATIONS_SET_PREFS, async (_event, prefs: NotificationPrefs) => {
    const { getDb, saveDb } = await import('../db/database');
    writePrefsToConfig(getDb().config, prefs);
    saveDb();
  });

  ipcMain.handle(IPC.SESSION_SET_NOTIFICATIONS_MUTED, async (_event, sessionId: string, muted: boolean) => {
    sessionManager.setNotificationsMuted(sessionId, muted);
  });
}
