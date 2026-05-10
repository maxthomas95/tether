import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHarness, makeElectronMockBase, type IpcRegistry } from './ipc-test-harness.test-helper';

const registry = vi.hoisted<IpcRegistry>(() => ({ handlers: new Map(), listeners: new Map() }));
vi.mock('electron', () => makeElectronMockBase(registry));

const dbState = vi.hoisted(() => ({
  config: {} as Record<string, string>,
  defaultEnvVars: {} as Record<string, string>,
  defaultCliFlags: [] as string[],
  defaultCliFlagsPerTool: {} as Record<string, string[]>,
  repoGroupPrefs: [] as Array<{ environmentId: string; workingDir: string; pinned: boolean; sortOrder: number }>,
  sessionOrderPrefs: [] as Array<{ environmentId: string; workingDir: string; orderedIds: string[] }>,
  saveCount: 0,
}));

vi.mock('../db/database', () => ({
  getDb: () => dbState,
  saveDb: () => { dbState.saveCount += 1; },
}));

// CONFIG_SET on key='theme' tries to import ../index for the docs window.
vi.mock('../index', () => ({ getDocsWindow: () => null }));

import { IPC } from '../../shared/constants';
import { registerConfigHandlers } from './config-handlers';

const harness = createHarness(registry);

function resetDb() {
  dbState.config = {};
  dbState.defaultEnvVars = {};
  dbState.defaultCliFlags = [];
  dbState.defaultCliFlagsPerTool = {};
  dbState.repoGroupPrefs = [];
  dbState.sessionOrderPrefs = [];
  dbState.saveCount = 0;
}

describe('config-handlers', () => {
  beforeEach(() => {
    harness.reset();
    resetDb();
    registerConfigHandlers(harness.ctx);
  });

  describe('CONFIG_GET / CONFIG_SET', () => {
    it('CONFIG_GET returns the stored value, or null when missing', async () => {
      dbState.config.theme = 'mocha';
      expect(await harness.invoke(IPC.CONFIG_GET, 'theme')).toBe('mocha');
      expect(await harness.invoke(IPC.CONFIG_GET, 'unknown')).toBeNull();
    });

    it('CONFIG_SET writes to db.config and persists', async () => {
      await harness.invoke(IPC.CONFIG_SET, 'theme', 'latte');
      expect(dbState.config.theme).toBe('latte');
      expect(dbState.saveCount).toBe(1);
    });
  });

  describe('default CLI flags', () => {
    it('GET returns the stored array', async () => {
      dbState.defaultCliFlags = ['--model', 'sonnet'];
      expect(await harness.invoke(IPC.CONFIG_GET_DEFAULT_CLI_FLAGS)).toEqual(['--model', 'sonnet']);
    });

    it('SET overwrites and saves', async () => {
      await harness.invoke(IPC.CONFIG_SET_DEFAULT_CLI_FLAGS, ['--x']);
      expect(dbState.defaultCliFlags).toEqual(['--x']);
      expect(dbState.saveCount).toBe(1);
    });

    it('GET_PER_TOOL returns the stored map', async () => {
      dbState.defaultCliFlagsPerTool = { claude: ['--a'], codex: ['--b'] };
      expect(await harness.invoke(IPC.CONFIG_GET_DEFAULT_CLI_FLAGS_PER_TOOL)).toEqual({ claude: ['--a'], codex: ['--b'] });
    });

    it('SET_FOR_TOOL adds when flags non-empty', async () => {
      await harness.invoke(IPC.CONFIG_SET_DEFAULT_CLI_FLAGS_FOR_TOOL, 'claude', ['--a']);
      expect(dbState.defaultCliFlagsPerTool).toEqual({ claude: ['--a'] });
      expect(dbState.saveCount).toBe(1);
    });

    it('SET_FOR_TOOL deletes the entry when flags is empty', async () => {
      dbState.defaultCliFlagsPerTool = { claude: ['--a'], codex: ['--b'] };
      await harness.invoke(IPC.CONFIG_SET_DEFAULT_CLI_FLAGS_FOR_TOOL, 'claude', []);
      expect(dbState.defaultCliFlagsPerTool).toEqual({ codex: ['--b'] });
    });
  });

  describe('default env vars', () => {
    it('round-trips through GET / SET', async () => {
      await harness.invoke(IPC.CONFIG_SET_DEFAULT_ENV_VARS, { K: 'v', X: 'y' });
      expect(dbState.defaultEnvVars).toEqual({ K: 'v', X: 'y' });
      expect(await harness.invoke(IPC.CONFIG_GET_DEFAULT_ENV_VARS)).toEqual({ K: 'v', X: 'y' });
    });
  });

  describe('repo group prefs', () => {
    it('SET replaces only entries for the given environmentId', async () => {
      dbState.repoGroupPrefs = [
        { environmentId: 'e1', workingDir: '/a', pinned: false, sortOrder: 0 },
        { environmentId: 'e2', workingDir: '/b', pinned: false, sortOrder: 0 },
      ];
      const newPrefs = [{ environmentId: 'e1', workingDir: '/c', pinned: true, sortOrder: 1 }];
      await harness.invoke(IPC.REPOGROUP_SET_PREFS, 'e1', newPrefs);
      expect(dbState.repoGroupPrefs).toEqual([
        { environmentId: 'e2', workingDir: '/b', pinned: false, sortOrder: 0 },
        { environmentId: 'e1', workingDir: '/c', pinned: true, sortOrder: 1 },
      ]);
    });

    it('GET returns the stored array', async () => {
      dbState.repoGroupPrefs = [{ environmentId: 'e1', workingDir: '/x', pinned: true, sortOrder: 0 }];
      expect(await harness.invoke(IPC.REPOGROUP_GET_PREFS)).toEqual(dbState.repoGroupPrefs);
    });
  });

  describe('session order prefs', () => {
    it('SET replaces only the matching (environmentId, workingDir) entry', async () => {
      dbState.sessionOrderPrefs = [
        { environmentId: 'e1', workingDir: '/a', orderedIds: ['x'] },
        { environmentId: 'e1', workingDir: '/b', orderedIds: ['y'] },
      ];
      await harness.invoke(IPC.SESSIONORDER_SET_PREF, 'e1', '/a', ['z']);
      expect(dbState.sessionOrderPrefs).toEqual([
        { environmentId: 'e1', workingDir: '/b', orderedIds: ['y'] },
        { environmentId: 'e1', workingDir: '/a', orderedIds: ['z'] },
      ]);
    });
  });

  describe('TITLEBAR_UPDATE', () => {
    it('calls setTitleBarOverlay on the live window', async () => {
      await harness.invoke(IPC.TITLEBAR_UPDATE, '#000', '#fff');
      const setOverlay = harness.ctx.mainWindow.setTitleBarOverlay as unknown as ReturnType<typeof vi.fn>;
      expect(setOverlay).toHaveBeenCalledWith({ color: '#000', symbolColor: '#fff', height: 36 });
    });
  });
});
