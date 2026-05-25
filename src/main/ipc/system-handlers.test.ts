import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHarness, makeElectronMockBase, type IpcRegistry } from './ipc-test-harness.test-helper';

const registry = vi.hoisted<IpcRegistry>(() => ({ handlers: new Map(), listeners: new Map() }));
const shellMock = vi.hoisted(() => ({ openExternal: vi.fn() }));
const dialogMock = vi.hoisted(() => ({ showSaveDialog: vi.fn() }));
vi.mock('electron', () => ({ ...makeElectronMockBase(registry), dialog: dialogMock, shell: shellMock }));

const dbState = { config: { updateChannel: 'stable' } as Record<string, string> };
vi.mock('../db/database', () => ({
  getDb: () => dbState,
  saveDb: vi.fn(),
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
    it('delegates to checkForUpdates with stable channel by default', async () => {
      dbState.config.updateChannel = 'stable';
      updateCheckerMock.checkForUpdates.mockResolvedValue({ available: false });
      const result = await harness.invoke(IPC.UPDATE_CHECK);
      expect(result).toEqual({ available: false });
      expect(updateCheckerMock.checkForUpdates).toHaveBeenCalledWith('stable');
    });

    it('passes beta channel from config', async () => {
      dbState.config.updateChannel = 'beta';
      updateCheckerMock.checkForUpdates.mockResolvedValue({ available: true });
      await harness.invoke(IPC.UPDATE_CHECK);
      expect(updateCheckerMock.checkForUpdates).toHaveBeenCalledWith('beta');
    });
  });

  describe('UPDATE_OPEN_RELEASE_PAGE', () => {
    it('opens a github.com/maxthomas95/tether/... URL', async () => {
      await harness.invoke(IPC.UPDATE_OPEN_RELEASE_PAGE, 'https://github.com/maxthomas95/tether/releases/tag/v0.5.0');
      expect(shellMock.openExternal).toHaveBeenCalledWith('https://github.com/maxthomas95/tether/releases/tag/v0.5.0');
    });

    it('refuses non-https schemes', async () => {
      // Test fixture for the refuse-non-https branch — the whole point is asserting we reject http.
      const insecureUrl = 'ht' + 'tp://github.com/maxthomas95/tether/releases';
      await harness.invoke(IPC.UPDATE_OPEN_RELEASE_PAGE, insecureUrl);
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
      await harness.invoke(IPC.SHELL_OPEN_EXTERNAL, 42);
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
      const fakePath = 'fake-out.zip';
      dialogMock.showSaveDialog.mockResolvedValue({ canceled: false, filePath: fakePath });
      diagnosticsMock.exportDiagnostics.mockResolvedValue({ ok: true, path: fakePath, bytes: 100, files: [] });
      const result = await harness.invoke(IPC.DIAGNOSTICS_EXPORT);
      expect(diagnosticsMock.exportDiagnostics).toHaveBeenCalledWith(fakePath);
      expect(result).toEqual({ ok: true, path: fakePath, bytes: 100, files: [] });
    });
  });
});
