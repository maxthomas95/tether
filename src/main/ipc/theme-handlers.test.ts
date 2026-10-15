import { beforeEach, expect, it, vi } from 'vitest';
import { createHarness, makeElectronMockBase, type IpcRegistry } from './ipc-test-harness.test-helper';

const registry = vi.hoisted<IpcRegistry>(() => ({ handlers: new Map(), listeners: new Map() }));
const mocks = vi.hoisted(() => ({
  catalog: { directory: '/themes', themes: [], issues: [] },
  ensure: vi.fn(), reload: vi.fn(), openPath: vi.fn().mockResolvedValue(''),
}));
vi.mock('electron', () => ({ ...makeElectronMockBase(registry), shell: { openPath: mocks.openPath } }));
vi.mock('../themes/local-themes', () => ({
  getLocalThemeCatalog: () => mocks.catalog,
  getThemesDirectory: () => '/themes',
  ensureThemesDirectory: mocks.ensure,
  loadLocalThemes: mocks.reload,
}));
vi.mock('../db/database', () => ({ getDb: () => ({ config: { theme: 'tether-light' } }) }));
import { IPC } from '../../shared/constants';
import { registerThemeHandlers } from './theme-handlers';

const harness = createHarness(registry);
const docs = createHarness({ handlers: new Map(), listeners: new Map() }).ctx.mainWindow;

beforeEach(() => {
  harness.reset();
  vi.clearAllMocks();
  mocks.reload.mockReturnValue(mocks.catalog);
  registerThemeHandlers(harness.ctx, () => docs);
});

it('lets the main window reload and open only the app-managed themes directory', async () => {
  expect(await harness.invoke(IPC.THEMES_RELOAD)).toEqual(mocks.catalog);
  expect(mocks.reload).toHaveBeenCalledOnce();
  expect(docs.webContents.send).toHaveBeenCalledWith(IPC.DOCS_THEME_CHANGED, 'tether-light', []);
  await harness.invoke(IPC.THEMES_OPEN_FOLDER, '../other');
  expect(mocks.ensure).toHaveBeenCalledOnce();
  expect(mocks.openPath).toHaveBeenCalledWith('/themes');
});

it('allows the documentation main frame to read themes but not reload or open folders', async () => {
  const event = { sender: docs.webContents, senderFrame: docs.webContents.mainFrame };
  expect(await registry.handlers.get(IPC.THEMES_LIST)!(event)).toEqual(mocks.catalog);
  for (const channel of [IPC.THEMES_RELOAD, IPC.THEMES_OPEN_FOLDER]) {
    expect(() => registry.handlers.get(channel)!(event)).toThrow('Tether window');
  }
});

it('rejects unrelated windows and subframes on every theme channel', () => {
  for (const event of [{ sender: {}, senderFrame: {} }, { sender: harness.ctx.mainWindow.webContents, senderFrame: {} }]) {
    for (const channel of [IPC.THEMES_LIST, IPC.THEMES_RELOAD, IPC.THEMES_OPEN_FOLDER]) {
      expect(() => registry.handlers.get(channel)!(event)).toThrow('Tether window');
    }
  }
});

it('reports a folder-open failure', async () => {
  mocks.openPath.mockResolvedValueOnce('Folder could not be opened.');
  await expect(harness.invoke(IPC.THEMES_OPEN_FOLDER)).rejects.toThrow('Folder could not be opened.');
});
