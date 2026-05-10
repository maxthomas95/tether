import { describe, it, expect, beforeEach, vi } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const registry = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  listeners: new Map<string, (event: unknown, ...args: unknown[]) => void>(),
}));

const dialogMock = vi.hoisted(() => ({ showOpenDialog: vi.fn() }));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (event: unknown, ...args: unknown[]) => unknown) => { registry.handlers.set(ch, fn); },
    on: (ch: string, fn: (event: unknown, ...args: unknown[]) => void) => { registry.listeners.set(ch, fn); },
  },
  dialog: dialogMock,
}));

import { IPC } from '../../shared/constants';
import { registerDialogHandlers } from './dialog-handlers';
import { createHarness } from './ipc-test-harness.test-helper';

const harness = createHarness(registry);

describe('dialog-handlers', () => {
  beforeEach(() => {
    harness.reset();
    dialogMock.showOpenDialog.mockReset();
    registerDialogHandlers(harness.ctx);
  });

  describe('DIALOG_OPEN_DIRECTORY', () => {
    it('returns null when the user cancels', async () => {
      dialogMock.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
      const result = await harness.invoke(IPC.DIALOG_OPEN_DIRECTORY);
      expect(result).toBeNull();
    });

    it('returns the chosen path when the user confirms', async () => {
      dialogMock.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/some/path'] });
      const result = await harness.invoke(IPC.DIALOG_OPEN_DIRECTORY);
      expect(result).toBe('/some/path');
    });

    it('returns null when filePaths is empty even though not canceled', async () => {
      dialogMock.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [] });
      expect(await harness.invoke(IPC.DIALOG_OPEN_DIRECTORY)).toBeNull();
    });
  });

  describe('SCAN_REPOS_DIR', () => {
    let scratch: string;

    beforeEach(() => {
      scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-scan-'));
    });

    it('returns sorted dir paths and skips dotfiles + files', async () => {
      fs.mkdirSync(path.join(scratch, 'beta'));
      fs.mkdirSync(path.join(scratch, 'alpha'));
      fs.mkdirSync(path.join(scratch, '.hidden'));
      fs.writeFileSync(path.join(scratch, 'README.md'), 'hi');

      const result = await harness.invoke<string[]>(IPC.SCAN_REPOS_DIR, scratch);
      expect(result).toEqual([
        path.join(scratch, 'alpha'),
        path.join(scratch, 'beta'),
      ]);

      fs.rmSync(scratch, { recursive: true, force: true });
    });

    it('returns [] for nonexistent directories rather than throwing', async () => {
      const result = await harness.invoke<string[]>(IPC.SCAN_REPOS_DIR, '/this/does/not/exist');
      expect(result).toEqual([]);
    });
  });
});
