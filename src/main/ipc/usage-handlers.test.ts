import { describe, it, expect, beforeEach, vi } from 'vitest';

const registry = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  listeners: new Map<string, (event: unknown, ...args: unknown[]) => void>(),
}));

const dialogMock = vi.hoisted(() => ({ showSaveDialog: vi.fn() }));
const appMock = vi.hoisted(() => ({ getVersion: vi.fn(() => '0.5.0') }));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (event: unknown, ...args: unknown[]) => unknown) => { registry.handlers.set(ch, fn); },
    on: (ch: string, fn: (event: unknown, ...args: unknown[]) => void) => { registry.listeners.set(ch, fn); },
  },
  dialog: dialogMock,
  app: appMock,
}));

const quotaServiceMock = vi.hoisted(() => ({
  onUpdate: vi.fn(),
  getQuota: vi.fn(),
  fetchQuota: vi.fn(),
  setEnabled: vi.fn(),
}));
vi.mock('../quota/quota-service', () => ({ quotaService: quotaServiceMock }));

const usageServiceMock = vi.hoisted(() => ({
  onUpdate: vi.fn(),
  getSessionUsage: vi.fn(),
  getAll: vi.fn(),
  refresh: vi.fn(),
  getEnrichedSessions: vi.fn(),
}));
vi.mock('../usage/usage-service', () => ({ usageService: usageServiceMock }));

const exporterMock = vi.hoisted(() => ({
  serializeUsageCsv: vi.fn(() => 'csv-output'),
  serializeUsageJson: vi.fn(() => '{"json":true}'),
}));
vi.mock('../usage/usage-exporter', () => exporterMock);

const writeFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock('node:fs', () => ({ writeFileSync: writeFileSyncMock, default: { writeFileSync: writeFileSyncMock } }));

import { IPC } from '../../shared/constants';
import { registerUsageHandlers } from './usage-handlers';
import { createHarness } from './ipc-test-harness.test-helper';

const harness = createHarness(registry);

describe('usage-handlers', () => {
  beforeEach(() => {
    harness.reset();
    Object.values(quotaServiceMock).forEach((m) => m.mockReset());
    Object.values(usageServiceMock).forEach((m) => m.mockReset());
    dialogMock.showSaveDialog.mockReset();
    writeFileSyncMock.mockReset();
    exporterMock.serializeUsageCsv.mockClear();
    exporterMock.serializeUsageJson.mockClear();
    registerUsageHandlers(harness.ctx);
  });

  it('subscribes to quotaService updates and forwards to renderer', () => {
    expect(quotaServiceMock.onUpdate).toHaveBeenCalledTimes(1);
    const cb = quotaServiceMock.onUpdate.mock.calls[0][0] as (info: unknown) => void;
    cb({ used: 1 });
    expect(harness.send).toHaveBeenCalledWith(IPC.QUOTA_UPDATED, { used: 1 });
  });

  it('subscribes to usageService updates and forwards to renderer', () => {
    expect(usageServiceMock.onUpdate).toHaveBeenCalledTimes(1);
    const cb = usageServiceMock.onUpdate.mock.calls[0][0] as (info: unknown) => void;
    cb({ totalCost: 1.23 });
    expect(harness.send).toHaveBeenCalledWith(IPC.USAGE_UPDATED, { totalCost: 1.23 });
  });

  it('QUOTA_GET / QUOTA_REFRESH / QUOTA_SET_ENABLED forward to the service', async () => {
    quotaServiceMock.getQuota.mockReturnValue({ k: 1 });
    quotaServiceMock.fetchQuota.mockResolvedValue({ k: 2 });
    expect(await harness.invoke(IPC.QUOTA_GET)).toEqual({ k: 1 });
    expect(await harness.invoke(IPC.QUOTA_REFRESH)).toEqual({ k: 2 });
    await harness.invoke(IPC.QUOTA_SET_ENABLED, false);
    expect(quotaServiceMock.setEnabled).toHaveBeenCalledWith(false);
  });

  it('USAGE_GET_SESSION / USAGE_GET_ALL / USAGE_REFRESH forward to the service', async () => {
    usageServiceMock.getSessionUsage.mockReturnValue({ id: 'a' });
    usageServiceMock.getAll.mockReturnValue({ all: true });
    usageServiceMock.refresh.mockResolvedValue({ refreshed: true });
    expect(await harness.invoke(IPC.USAGE_GET_SESSION, 'sess-1')).toEqual({ id: 'a' });
    expect(usageServiceMock.getSessionUsage).toHaveBeenCalledWith('sess-1');
    expect(await harness.invoke(IPC.USAGE_GET_ALL)).toEqual({ all: true });
    await harness.invoke(IPC.USAGE_REFRESH, 'sess-1');
    expect(usageServiceMock.refresh).toHaveBeenCalledWith('sess-1');
  });

  describe('USAGE_EXPORT', () => {
    it('returns ok:false when the user cancels', async () => {
      dialogMock.showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined });
      const result = await harness.invoke(IPC.USAGE_EXPORT, 'csv');
      expect(result).toEqual({ ok: false });
      expect(writeFileSyncMock).not.toHaveBeenCalled();
    });

    it('CSV export writes the CSV body and returns ok:true with sessionCount', async () => {
      dialogMock.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/tmp/usage.csv' });
      usageServiceMock.getAll.mockReturnValue({});
      usageServiceMock.getEnrichedSessions.mockReturnValue([{ id: 's1' }, { id: 's2' }]);
      const result = await harness.invoke<{ ok: boolean; filePath?: string; sessionCount?: number }>(IPC.USAGE_EXPORT, 'csv');
      expect(exporterMock.serializeUsageCsv).toHaveBeenCalled();
      expect(writeFileSyncMock).toHaveBeenCalledWith('/tmp/usage.csv', 'csv-output', 'utf8');
      expect(result).toEqual({ ok: true, filePath: '/tmp/usage.csv', sessionCount: 2 });
    });

    it('JSON export uses serializeUsageJson with app version', async () => {
      dialogMock.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/tmp/usage.json' });
      usageServiceMock.getAll.mockReturnValue({});
      usageServiceMock.getEnrichedSessions.mockReturnValue([]);
      await harness.invoke(IPC.USAGE_EXPORT, 'json');
      expect(exporterMock.serializeUsageJson).toHaveBeenCalledWith({}, [], '0.5.0');
      expect(writeFileSyncMock).toHaveBeenCalledWith('/tmp/usage.json', '{"json":true}', 'utf8');
    });

    it('returns ok:false with error message when write fails', async () => {
      dialogMock.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/tmp/usage.csv' });
      usageServiceMock.getAll.mockReturnValue({});
      usageServiceMock.getEnrichedSessions.mockReturnValue([]);
      writeFileSyncMock.mockImplementation(() => { throw new Error('disk full'); });
      const result = await harness.invoke<{ ok: boolean; error?: string }>(IPC.USAGE_EXPORT, 'csv');
      expect(result).toEqual({ ok: false, error: 'disk full' });
    });

    it('coerces unknown formats to csv', async () => {
      dialogMock.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/tmp/x.csv' });
      usageServiceMock.getAll.mockReturnValue({});
      usageServiceMock.getEnrichedSessions.mockReturnValue([]);
      await harness.invoke(IPC.USAGE_EXPORT, 'unknown' as unknown as 'csv');
      expect(exporterMock.serializeUsageCsv).toHaveBeenCalled();
      expect(exporterMock.serializeUsageJson).not.toHaveBeenCalled();
    });
  });
});
