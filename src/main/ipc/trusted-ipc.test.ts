import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
const registry = vi.hoisted(() => ({ handles: new Map<string, Function>(), listeners: new Map<string, Function>() }));
vi.mock('electron', () => ({ ipcMain: {
  handle: (channel: string, fn: Function) => registry.handles.set(channel, fn),
  on: (channel: string, fn: Function) => registry.listeners.set(channel, fn),
} }));
import { createTrustedIpc, isTrustedSender } from './trusted-ipc';
const frame = {};
const contents = { mainFrame: frame };
const win = { isDestroyed: () => false, webContents: contents } as unknown as BrowserWindow;
const trusted = { sender: contents, senderFrame: frame } as IpcMainInvokeEvent;
describe('privileged IPC sender gate', () => {
  beforeEach(() => { registry.handles.clear(); registry.listeners.clear(); });
  it('blocks guests, docs windows, subframes and detached frames before accessing secrets or PTY input', () => {
    const read = vi.fn(); const input = vi.fn();
    const ipc = createTrustedIpc(win); ipc.handle('read', read); ipc.on('input', input);
    for (const event of [{ sender: {}, senderFrame: frame }, { sender: contents, senderFrame: {} }, { sender: contents, senderFrame: null }]) {
      expect(() => registry.handles.get('read')!(event)).toThrow('Tether window');
      registry.listeners.get('input')!(event, 'session', 'bytes');
    }
    expect(read).not.toHaveBeenCalled(); expect(input).not.toHaveBeenCalled();
    registry.handles.get('read')!(trusted, 'setting');
    registry.listeners.get('input')!(trusted, 'session', 'bytes');
    expect(read).toHaveBeenCalledWith(trusted, 'setting');
    expect(input).toHaveBeenCalledWith(trusted, 'session', 'bytes');
    expect(isTrustedSender({ ...win, isDestroyed: () => true } as BrowserWindow, trusted)).toBe(false);
  });
});
