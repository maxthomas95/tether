import { describe, it, expect, beforeEach, vi } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createHarness, makeElectronMockBase, type IpcRegistry } from './ipc-test-harness.test-helper';

const registry = vi.hoisted<IpcRegistry>(() => ({ handlers: new Map(), listeners: new Map() }));
const dialogMock = vi.hoisted(() => ({ showOpenDialog: vi.fn() }));
vi.mock('electron', () => ({ ...makeElectronMockBase(registry), dialog: dialogMock }));

import { IPC } from '../../shared/constants';
import { registerDialogHandlers } from './dialog-handlers';

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
