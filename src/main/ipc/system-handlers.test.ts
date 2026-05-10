import { describe, it, expect, beforeEach, vi } from 'vitest';

const registry = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  listeners: new Map<string, (event: unknown, ...args: unknown[]) => void>(),
}));

const shellMock = vi.hoisted(() => ({ openExternal: vi.fn() }));
const dialogMock = vi.hoisted(() => ({ showSaveDialog: vi.fn() }));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (event: unknown, ...args: unknown[]) => unknown) => { registry.handlers.set(ch, fn); },
    on: (ch: string, fn: (event: unknown, ...args: unknown[]) => void) => { registry.listeners.set(ch, fn); },
  },
  dialog: dialogMock,
  shell: shellMock,
}));

const updateCheckerMock = vi.hoisted(() => ({ checkForUpdates: vi.fn() }));
vi.mock('../update/update-checker', () => updateCheckerMock);

const diagnosticsMock = vi.hoisted(() => ({
  exportDiagnostics: vi.fn(),
  defaultExportFilename: vi.fn(() => 'tether-diagnostics-test.zip'),
}));
vi.mock('../diagnostics/diagnostics-service', () => diagnosticsMock);

import { IPC } from '../../shared/constants';
import { registerSystemHandlers } from './system-handlers';
import { createHarness } from './ipc-test-harness.test-helper';

const harness = createHarness(registry);

describe('system-handlers', () => {
  beforeEach(() => {
    harness.reset();
    shellMock.openExternal.mockReset();
    dialogMock.showSaveDialog.mockReset();
    updateCheckerMock.checkForUpdates.mockReset();
    diagnosticsMock.exportDiagnostics.mockReset();
    diagnosticsMock.defaultExportFilename.mockClear();
    registerSystemHandlers(harness.ctx);
  });

  describe('UPDATE_CHECK', () => {
    it('delegates to checkForUpdates', async () => {
      updateCheckerMock.checkForUpdates.mockResolvedValue({ available: false });
      const result = await harness.invoke(IPC.UPDATE_CHECK);
      expect(result).toEqual({ available: false });
    });
  });

  describe('UPDATE_OPEN_RELEASE_PAGE', () => {
    it('opens a github.com/maxthomas95/tether/... URL', async () => {
      await harness.invoke(IPC.UPDATE_OPEN_RELEASE_PAGE, 'https://github.com/maxthomas95/tether/releases/tag/v0.5.0');
      expect(shellMock.openExternal).toHaveBeenCalledWith('https://github.com/maxthomas95/tether/releases/tag/v0.5.0');
    });

    it('refuses non-https schemes', async () => {
      await harness.invoke(IPC.UPDATE_OPEN_RELEASE_PAGE, 'http://github.com/maxthomas95/tether/releases');
      expect(shellMock.openExternal).not.toHaveBeenCalled();
    });

    it('refuses different hosts', async () => {
      await harness.invoke(IPC.UPDATE_OPEN_RELEASE_PAGE, 'https://example.com/maxthomas95/tether/releases');
      expect(shellMock.openExternal).not.toHaveBeenCalled();
    });

    it('refuses different paths', async () => {
      await harness.invoke(IPC.UPDATE_OPEN_RELEASE_PAGE, 'https://github.com/someoneelse/repo/releases');
      expect(shellMock.openExternal).not.toHaveBeenCalled();
    });

    it('refuses malformed URLs without throwing', async () => {
      await harness.invoke(IPC.UPDATE_OPEN_RELEASE_PAGE, 'not a url');
      expect(shellMock.openExternal).not.toHaveBeenCalled();
    });
  });

  describe('SHELL_OPEN_EXTERNAL', () => {
    it('opens an http/https URL', async () => {
      await harness.invoke(IPC.SHELL_OPEN_EXTERNAL, 'https://example.com/path');
      expect(shellMock.openExternal).toHaveBeenCalledWith('https://example.com/path');
    });

    it('refuses URLs longer than 2048 chars', async () => {
      const long = 'https://example.com/' + 'x'.repeat(2050);
      await harness.invoke(IPC.SHELL_OPEN_EXTERNAL, long);
      expect(shellMock.openExternal).not.toHaveBeenCalled();
    });

    it('refuses non-string input', async () => {
      await harness.invoke(IPC.SHELL_OPEN_EXTERNAL, 42 as unknown as string);
      expect(shellMock.openExternal).not.toHaveBeenCalled();
    });

    it('refuses non-http(s) protocols (file://, javascript:)', async () => {
      await harness.invoke(IPC.SHELL_OPEN_EXTERNAL, 'file:///etc/passwd');
      await harness.invoke(IPC.SHELL_OPEN_EXTERNAL, 'javascript:alert(1)');
      expect(shellMock.openExternal).not.toHaveBeenCalled();
    });

    it('refuses malformed URLs without throwing', async () => {
      await harness.invoke(IPC.SHELL_OPEN_EXTERNAL, 'not a url');
      expect(shellMock.openExternal).not.toHaveBeenCalled();
    });
  });

  describe('DIAGNOSTICS_EXPORT', () => {
    it('cancelled save dialog returns ok:false / cancelled', async () => {
      dialogMock.showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined });
      const result = await harness.invoke(IPC.DIAGNOSTICS_EXPORT);
      expect(result).toEqual({ ok: false, error: 'cancelled' });
      expect(diagnosticsMock.exportDiagnostics).not.toHaveBeenCalled();
    });

    it('confirmed save dialog forwards to exportDiagnostics', async () => {
      dialogMock.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/tmp/out.zip' });
      diagnosticsMock.exportDiagnostics.mockResolvedValue({ ok: true, path: '/tmp/out.zip', bytes: 100, files: [] });
      const result = await harness.invoke(IPC.DIAGNOSTICS_EXPORT);
      expect(diagnosticsMock.exportDiagnostics).toHaveBeenCalledWith('/tmp/out.zip');
      expect(result).toEqual({ ok: true, path: '/tmp/out.zip', bytes: 100, files: [] });
    });
  });
});
