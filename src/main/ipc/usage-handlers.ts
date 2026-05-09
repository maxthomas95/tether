import { ipcMain } from 'electron';
import { IPC } from '../../shared/constants';
import type { QuotaInfo, UsageInfo, SessionUsage } from '../../shared/types';
import { quotaService } from '../quota/quota-service';
import { usageService } from '../usage/usage-service';
import type { HandlerContext } from './helpers';

export function registerUsageHandlers(ctx: HandlerContext): void {
  const { send } = ctx;

  // === Quota ===

  quotaService.onUpdate((info: QuotaInfo) => {
    send(IPC.QUOTA_UPDATED, info);
  });

  ipcMain.handle(IPC.QUOTA_GET, async (): Promise<QuotaInfo> => {
    return quotaService.getQuota();
  });

  ipcMain.handle(IPC.QUOTA_REFRESH, async (): Promise<QuotaInfo> => {
    return quotaService.fetchQuota();
  });

  ipcMain.handle(IPC.QUOTA_SET_ENABLED, async (_event, enabled: boolean): Promise<void> => {
    quotaService.setEnabled(enabled);
  });

  // === Usage tracking ===

  usageService.onUpdate((info: UsageInfo) => {
    send(IPC.USAGE_UPDATED, info);
  });

  ipcMain.handle(IPC.USAGE_GET_SESSION, async (_event, sessionId: string): Promise<SessionUsage | null> => {
    return usageService.getSessionUsage(sessionId);
  });

  ipcMain.handle(IPC.USAGE_GET_ALL, async (): Promise<UsageInfo> => {
    return usageService.getAll();
  });

  ipcMain.handle(IPC.USAGE_REFRESH, async (_event, sessionId?: string): Promise<UsageInfo> => {
    return usageService.refresh(sessionId);
  });
}
