import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, makeElectronMockBase, type IpcRegistry } from './ipc-test-harness.test-helper';

const registry = vi.hoisted<IpcRegistry>(() => ({ handlers: new Map(), listeners: new Map() }));
const mocks = vi.hoisted(() => ({
  db: { config: {} as Record<string, string> },
  saveDb: vi.fn(),
  showOpenDialog: vi.fn(),
  gif: {
    saved: undefined as unknown,
    persist: (() => {}) as (settings: unknown) => void,
    getSettings: vi.fn(() => ({ enabled: true })),
    updateSettings: vi.fn((patch: unknown) => patch),
    addSources: vi.fn((paths: string[]) => ({ sources: paths })),
    removeSource: vi.fn(),
    getLibrary: vi.fn(() => []),
    readImage: vi.fn(),
  },
  jobs: {
    status: { detected: true },
    listener: (() => {}) as (status: unknown) => void,
    refresh: vi.fn(),
    getStatus: vi.fn(),
    read: vi.fn(() => ({ enabled: true })),
    save: vi.fn(),
    disable: vi.fn(),
  },
}));

vi.mock('electron', () => ({ ...makeElectronMockBase(registry), dialog: { showOpenDialog: mocks.showOpenDialog } }));
vi.mock('../db/database', () => ({ getDb: () => mocks.db, saveDb: mocks.saveDb }));
vi.mock('../gif-panel/gif-panel-service', () => ({
  GifPanelService: class {
    constructor(saved: unknown, persist: (settings: unknown) => void) {
      mocks.gif.saved = saved;
      mocks.gif.persist = persist;
    }
    getSettings = mocks.gif.getSettings;
    updateSettings = mocks.gif.updateSettings;
    addSources = mocks.gif.addSources;
    removeSource = mocks.gif.removeSource;
    getLibrary = mocks.gif.getLibrary;
    readImage = mocks.gif.readImage;
  },
}));
vi.mock('../jobs/jobs-service', () => ({
  jobsService: {
    refresh: mocks.jobs.refresh,
    getStatus: mocks.jobs.getStatus,
    onStatusChange: (listener: (status: unknown) => void) => { mocks.jobs.listener = listener; },
  },
}));
vi.mock('../jobs/jobs-config', () => ({
  readJobsConfig: mocks.jobs.read, saveJobsConfig: mocks.jobs.save, disableJobsConfig: mocks.jobs.disable,
}));

import { IPC } from '../../shared/constants';
import { registerGifPanelHandlers } from './gif-panel-handlers';
import { registerJobsHandlers } from './jobs-handlers';

const harness = createHarness(registry);

beforeEach(() => {
  harness.reset();
  vi.clearAllMocks();
  mocks.db.config = {};
  mocks.jobs.refresh.mockResolvedValue(mocks.jobs.status);
  mocks.jobs.getStatus.mockReturnValue(mocks.jobs.status);
});

describe('GIF panel handlers', () => {
  it('restores saved preferences and falls back to defaults when they are malformed', () => {
    mocks.db.config.gifPanel = JSON.stringify({ enabled: true, sources: ['/gifs'] });
    registerGifPanelHandlers(harness.ctx);
    expect(mocks.gif.saved).toEqual({ enabled: true, sources: ['/gifs'] });

    mocks.db.config.gifPanel = '{not json';
    registerGifPanelHandlers(harness.ctx);
    expect(mocks.gif.saved).toBeUndefined();

    mocks.db.config = {};
    registerGifPanelHandlers(harness.ctx);
    expect(mocks.gif.saved).toBeNull();
  });

  it('persists settings and rolls the stored value back when the save fails', () => {
    registerGifPanelHandlers(harness.ctx);

    mocks.gif.persist({ enabled: true });
    expect(mocks.db.config.gifPanel).toBe('{"enabled":true}');
    expect(mocks.saveDb).toHaveBeenCalledOnce();

    mocks.saveDb.mockImplementation(() => { throw new Error('disk full'); });
    expect(() => mocks.gif.persist({ enabled: false })).toThrow('disk full');
    expect(mocks.db.config.gifPanel).toBe('{"enabled":true}');

    mocks.db.config = {};
    expect(() => mocks.gif.persist({ enabled: false })).toThrow('disk full');
    expect(mocks.db.config).not.toHaveProperty('gifPanel');
  });

  it('routes each request to the service', async () => {
    registerGifPanelHandlers(harness.ctx);

    expect(await harness.invoke(IPC.GIF_PANEL_GET_SETTINGS)).toEqual({ enabled: true });
    await harness.invoke(IPC.GIF_PANEL_UPDATE_SETTINGS, { enabled: false });
    await harness.invoke(IPC.GIF_PANEL_REMOVE_SOURCE, '/gifs');
    await harness.invoke(IPC.GIF_PANEL_GET_LIBRARY);
    await harness.invoke(IPC.GIF_PANEL_READ_IMAGE, 'image-1');

    expect(mocks.gif.updateSettings).toHaveBeenCalledWith({ enabled: false });
    expect(mocks.gif.removeSource).toHaveBeenCalledWith('/gifs');
    expect(mocks.gif.getLibrary).toHaveBeenCalledOnce();
    expect(mocks.gif.readImage).toHaveBeenCalledWith('image-1');
  });

  it('adds only the folders the user picked in the dialog', async () => {
    registerGifPanelHandlers(harness.ctx);

    mocks.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    expect(await harness.invoke(IPC.GIF_PANEL_ADD_SOURCES, '/not/from/dialog')).toEqual({ enabled: true });
    expect(mocks.gif.addSources).not.toHaveBeenCalled();

    mocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/gifs/a', '/gifs/b'] });
    expect(await harness.invoke(IPC.GIF_PANEL_ADD_SOURCES)).toEqual({ sources: ['/gifs/a', '/gifs/b'] });
    expect(mocks.showOpenDialog.mock.calls[0][1].properties).toEqual(['openDirectory', 'multiSelections']);
  });

  it('rejects requests from other windows and from subframes', () => {
    registerGifPanelHandlers(harness.ctx);
    const mainWebContents = harness.ctx.mainWindow.webContents;

    for (const event of [{ sender: {}, senderFrame: {} }, { sender: mainWebContents, senderFrame: {} }]) {
      for (const channel of [IPC.GIF_PANEL_GET_SETTINGS, IPC.GIF_PANEL_READ_IMAGE, IPC.GIF_PANEL_ADD_SOURCES]) {
        expect(() => registry.handlers.get(channel)!(event)).toThrow('main window');
      }
    }
    expect(mocks.gif.getSettings).not.toHaveBeenCalled();
  });
});

describe('J.O.B.S. handlers', () => {
  beforeEach(() => registerJobsHandlers(harness.ctx));

  it('reads settings and status without probing', async () => {
    expect(await harness.invoke(IPC.JOBS_GET_SETTINGS)).toEqual({ enabled: true });
    expect(await harness.invoke(IPC.JOBS_GET_STATUS)).toBe(mocks.jobs.status);
    expect(mocks.jobs.refresh).not.toHaveBeenCalled();
  });

  it('saves settings and answers with the refreshed status', async () => {
    const settings = { enabled: true, url: 'http://localhost:4000' };

    expect(await harness.invoke(IPC.JOBS_SAVE_SETTINGS, settings)).toBe(mocks.jobs.status);

    expect(mocks.jobs.save).toHaveBeenCalledWith(settings);
    expect(mocks.jobs.refresh).toHaveBeenCalledOnce();
  });

  it('distinguishes disabling the integration from removing its settings', async () => {
    await harness.invoke(IPC.JOBS_DISABLE);
    expect(mocks.jobs.disable).toHaveBeenLastCalledWith();

    await harness.invoke(IPC.JOBS_REMOVE);
    expect(mocks.jobs.disable).toHaveBeenLastCalledWith(true);

    await harness.invoke(IPC.JOBS_REFRESH);
    expect(mocks.jobs.refresh).toHaveBeenCalledTimes(3);
  });

  it('pushes status changes to the renderer', () => {
    mocks.jobs.listener({ detected: false });
    expect(harness.send).toHaveBeenCalledWith(IPC.JOBS_STATUS_UPDATED, { detected: false });
  });
});
