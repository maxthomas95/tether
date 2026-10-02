import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
const mocks = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>(), listeners: new Map<string, (...args: unknown[]) => unknown>(),
  start: vi.fn(), cancel: vi.fn(), input: vi.fn(), resize: vi.fn(), dispose: vi.fn(), windowEvents: new Map<string, () => void>(), webEvents: new Map<string, () => void>() }));
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, fn: never) => mocks.handlers.set(channel, fn), on: (channel: string, fn: never) => mocks.listeners.set(channel, fn) } }));
vi.mock('../cli-maintenance/maintenance-target', () => ({ maintenanceTarget: vi.fn() }));
vi.mock('../cli-maintenance/maintenance-manager', () => ({ MaintenanceManager: class {
  start = mocks.start; cancel = mocks.cancel; input = mocks.input; resize = mocks.resize; dispose = mocks.dispose;
} }));
import { registerCliMaintenanceHandlers } from './cli-maintenance-handlers';
import { IPC } from '../../shared/constants';
const frame = {};
const webContents = { mainFrame: frame, on: (name: string, cb: () => void) => mocks.webEvents.set(name, cb) };
const window = { isDestroyed: () => false, webContents, on: (name: string, cb: () => void) => mocks.windowEvents.set(name, cb) } as unknown as BrowserWindow;
const trusted = { sender: webContents, senderFrame: frame };
describe('maintenance IPC boundary', () => {
  beforeEach(() => { vi.clearAllMocks(); registerCliMaintenanceHandlers({ mainWindow: window, send: vi.fn() }); });
  it('refuses other windows and nested frames before launching or cancelling processes', () => {
    for (const sender of [{ sender: {}, senderFrame: frame }, { sender: webContents, senderFrame: {} }]) {
      expect(() => mocks.handlers.get(IPC.CLI_MAINTENANCE_START)!(sender, {})).toThrow('Tether window');
      expect(() => mocks.handlers.get(IPC.CLI_MAINTENANCE_CANCEL)!(sender, 'id')).toThrow('Tether window');
      mocks.listeners.get(IPC.CLI_MAINTENANCE_INPUT)!(sender, 'id', 'secret');
    }
    expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.cancel).not.toHaveBeenCalled(); expect(mocks.input).not.toHaveBeenCalled();
    mocks.handlers.get(IPC.CLI_MAINTENANCE_START)!(trusted, { tool: 'claude' });
    expect(mocks.start).toHaveBeenCalledWith({ tool: 'claude' });
  });
  it('only forwards trusted interaction and disposes runs when the renderer closes or reloads', () => {
    mocks.listeners.get(IPC.CLI_MAINTENANCE_INPUT)!(trusted, 'id', '\r');
    mocks.listeners.get(IPC.CLI_MAINTENANCE_RESIZE)!(trusted, 'id', 80, 24);
    expect(mocks.input).toHaveBeenCalledWith('id', '\r'); expect(mocks.resize).toHaveBeenCalledWith('id', 80, 24);
    mocks.windowEvents.get('closed')!(); mocks.webEvents.get('render-process-gone')!(); mocks.webEvents.get('did-start-loading')!();
    expect(mocks.dispose).toHaveBeenCalledTimes(3);
  });
});
