import { ipcMain, app, dialog } from 'electron';
import { IPC } from '../../shared/constants';
import type {
  QuotaInfo,
  UsageInfo,
  SessionUsage,
  UsageExportFormat,
  UsageExportResult,
} from '../../shared/types';
import { quotaService } from '../quota/quota-service';
import { usageService } from '../usage/usage-service';
import { createLogger } from '../logger';
import type { HandlerContext } from './helpers';

const log = createLogger('ipc:usage');

export function registerUsageHandlers(ctx: HandlerContext): void {
  const { mainWindow, send } = ctx;

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

  ipcMain.handle(IPC.USAGE_EXPORT, async (_event, format: UsageExportFormat): Promise<UsageExportResult> => {
    const fmt: UsageExportFormat = format === 'json' ? 'json' : 'csv';
    const stamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const defaultName = `tether-usage-${stamp}.${fmt}`;
    const result = await dialog.showSaveDialog(mainWindow, {
      title: fmt === 'csv' ? 'Export usage as CSV' : 'Export usage as JSON',
      defaultPath: defaultName,
      filters: fmt === 'csv'
        ? [{ name: 'CSV', extensions: ['csv'] }]
        : [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false };

    try {
      const usage = usageService.getAll();
      const enriched = usageService.getEnrichedSessions();
      const { serializeUsageCsv, serializeUsageJson } = await import('../usage/usage-exporter');
      const body = fmt === 'csv'
        ? serializeUsageCsv(enriched)
        : serializeUsageJson(usage, enriched, app.getVersion());
      const fs = await import('node:fs');
      fs.writeFileSync(result.filePath, body, 'utf8');
      log.info('Usage exported', { format: fmt, filePath: result.filePath, sessionCount: enriched.length });
      return { ok: true, filePath: result.filePath, sessionCount: enriched.length };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('Usage export failed', { format: fmt, error: message });
      return { ok: false, error: message };
    }
  });
}
