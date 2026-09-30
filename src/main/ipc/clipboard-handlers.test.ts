import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { makeElectronMockBase, type IpcRegistry } from './ipc-test-harness.test-helper';

const registry = vi.hoisted<IpcRegistry>(() => ({ handlers: new Map(), listeners: new Map() }));
const clipboardMock = vi.hoisted(() => ({ writeText: vi.fn(), readText: vi.fn() }));
vi.mock('electron', () => ({ ...makeElectronMockBase(registry), clipboard: clipboardMock }));

import { IPC } from '../../shared/constants';
import { registerClipboardHandlers } from './clipboard-handlers';

const frame = {};
const webContents = { mainFrame: frame };
const trusted = { sender: webContents, senderFrame: frame };
const mainWindow = { isDestroyed: () => false, webContents } as unknown as BrowserWindow;

async function write(event: unknown, text: unknown) {
  return registry.handlers.get(IPC.CLIPBOARD_WRITE_TEXT)!(event, text);
}

describe('clipboard-handlers', () => {
  beforeEach(() => {
    registry.handlers.clear();
    registry.listeners.clear();
    clipboardMock.writeText.mockReset();
    clipboardMock.readText.mockReset();
    registerClipboardHandlers({ mainWindow, send: vi.fn() });
  });

  it('writes string text to the clipboard', async () => {
    await write(trusted, 'line one\nline two');
    expect(clipboardMock.writeText).toHaveBeenCalledExactlyOnceWith('line one\nline two');
  });

  it.each([undefined, null, 42, ['text'], { toString: () => 'text' }])(
    'ignores non-string input %j', async (value) => {
      await write(trusted, value);
      expect(clipboardMock.writeText).not.toHaveBeenCalled();
    },
  );

  it('rejects writes from other windows and nested frames', async () => {
    await expect(write({ sender: {}, senderFrame: frame }, 'x')).rejects.toThrow('Tether window');
    await expect(write({ sender: webContents, senderFrame: {} }, 'x')).rejects.toThrow('Tether window');
    expect(clipboardMock.writeText).not.toHaveBeenCalled();
  });

  it('registers no clipboard read channel', () => {
    expect([...registry.handlers.keys()]).toEqual([IPC.CLIPBOARD_WRITE_TEXT]);
    expect(clipboardMock.readText).not.toHaveBeenCalled();
  });
});
