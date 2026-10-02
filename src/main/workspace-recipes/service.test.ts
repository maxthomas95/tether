import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionInfo } from '../../shared/types';
import type { WorkspaceRecipe } from '../../shared/workspace-recipes';

const electronState = vi.hoisted(() => ({
  userData: `${process.env.TEMP || process.env.TMP || process.cwd()}\\tether-workspace-recipes-${process.pid}`,
}));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name !== 'userData') throw new Error(`unexpected app path: ${name}`);
      return electronState.userData;
    },
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from([...value].reverse().join(''), 'utf8'),
    decryptString: (value: Buffer) => [...value.toString('utf8')].reverse().join(''),
  },
}));

const sessionState = vi.hoisted(() => ({
  sessions: new Map<string, { toInfo(): SessionInfo }>(),
}));

vi.mock('../session/session-manager', () => ({
  sessionManager: {
    getSession: (id: string) => sessionState.sessions.get(id),
  },
}));

import { closeDb, getDb } from '../db/database';
import {
  captureWorkspaceRecipe,
  deleteWorkspaceRecipe,
  listWorkspaceRecipes,
  prepareOpenWorkspaceRecipe,
  renameWorkspaceRecipe,
} from './service';

function encryptIntent(payload: unknown): string {
  return `tether-safe:v1:${Buffer.from([...JSON.stringify(payload)].reverse().join('')).toString('base64')}`;
}

function recipe(overrides: Partial<WorkspaceRecipe> = {}): WorkspaceRecipe {
  return {
    id: 'recipe-1',
    version: 1,
    name: 'Morning',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    sessions: [{
      label: 'API',
      workingDir: 'C:/repo/api',
      cliTool: 'codex',
      launchSnapshotId: 'snap-1',
    }],
    layout: {
      mode: 'split',
      activeSessionIndex: 0,
      split: { type: 'leaf', sessionIndex: 0 },
    },
    ...overrides,
  };
}

async function resetDb(): Promise<void> {
  fs.mkdirSync(electronState.userData, { recursive: true });
  closeDb();
  fs.rmSync(electronState.userData, { recursive: true, force: true });
  fs.mkdirSync(electronState.userData, { recursive: true });
  sessionState.sessions.clear();
}

describe('workspace recipe service', () => {
  beforeEach(async () => {
    await resetDb();
    getDb().launchSnapshots['snap-1'] = {
      id: 'snap-1',
      version: 1,
      encryptedIntent: encryptIntent({ version: 1, env: { TOKEN: 'secret' } }),
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
  });

  afterEach(async () => {
    await resetDb();
    fs.rmSync(electronState.userData, { recursive: true, force: true });
  });

  it('defaults old databases without workspaceRecipes to an empty list', () => {
    closeDb();
    fs.writeFileSync(path.join(electronState.userData, 'data.json'), JSON.stringify({
      environments: [],
      sessions: [],
      launchProfiles: [],
      config: {},
      defaultEnvVars: {},
      defaultCliFlags: [],
      defaultCliFlagsPerTool: {},
      savedWorkspace: null,
      gitProviders: [],
      repoGroupPrefs: [],
      sessionOrderPrefs: [],
      usageSummaries: [],
      knownHosts: [],
      launchSnapshots: {},
    }, null, 2));
    expect(getDb().workspaceRecipes).toEqual([]);
  });

  it('defaults old databases to an empty recipe list and drops invalid recipes on reload', () => {
    const snapshots = getDb().launchSnapshots;
    closeDb();
    const valid = recipe({
      sessions: [{
        label: 'API',
        workingDir: 'C:/repo/api',
        cliTool: 'codex',
        launchSnapshotId: 'snap-1',
        env: { SECRET: 'drop-me' },
        cliArgs: ['--drop-me'],
      } as unknown as WorkspaceRecipe['sessions'][number]],
    });
    fs.writeFileSync(path.join(electronState.userData, 'data.json'), JSON.stringify({
      environments: [],
      sessions: [],
      launchProfiles: [],
      config: {},
      defaultEnvVars: {},
      defaultCliFlags: [],
      defaultCliFlagsPerTool: {},
      savedWorkspace: null,
      gitProviders: [],
      repoGroupPrefs: [],
      sessionOrderPrefs: [],
      usageSummaries: [],
      knownHosts: [],
      launchSnapshots: snapshots,
      workspaceRecipes: [valid, { ...valid, id: 'bad', name: '' }],
    }, null, 2));

    const reloaded = getDb();
    expect(reloaded.workspaceRecipes).toHaveLength(1);
    expect(reloaded.workspaceRecipes[0].sessions[0]).toEqual({
      label: 'API',
      workingDir: 'C:/repo/api',
      cliTool: 'codex',
      launchSnapshotId: 'snap-1',
    });
    expect(JSON.stringify(reloaded.workspaceRecipes)).not.toContain('SECRET');
    expect(JSON.stringify(reloaded.workspaceRecipes)).not.toContain('--drop-me');
  });

  it('captures authoritative safe live-session metadata and leaves the DB unchanged on failed capture', () => {
    sessionState.sessions.set('s1', { toInfo: () => ({
      id: 's1',
      environmentId: 'env-ssh',
      label: 'Remote API',
      workingDir: '/work/api',
      state: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
      cliTool: 'codex',
      toolSessionId: 'native-drop',
      launchSnapshotId: 'snap-1',
      parentSessionId: 'parent-drop',
      worktreeOf: 'worktree-drop',
    }) });
    const captured = captureWorkspaceRecipe({
      name: '  Morning  ',
      sessionIds: ['s1'],
      layout: { mode: 'split', activeSessionIndex: 0, split: { type: 'leaf', sessionIndex: 0 } },
    });
    expect(captured.name).toBe('Morning');
    expect(captured.sessions[0]).toEqual({
      label: 'Remote API',
      workingDir: '/work/api',
      environmentId: 'env-ssh',
      cliTool: 'codex',
      launchSnapshotId: 'snap-1',
    });
    expect(JSON.stringify(captured)).not.toContain('native-drop');
    expect(JSON.stringify(captured)).not.toContain('parent-drop');
    expect(JSON.stringify(captured)).not.toContain('worktree-drop');

    expect(() => captureWorkspaceRecipe({
      name: 'Broken',
      sessionIds: ['missing'],
      layout: { mode: 'split', activeSessionIndex: 0, split: { type: 'leaf', sessionIndex: 0 } },
    })).toThrow(/no longer running/);
    expect(getDb().workspaceRecipes).toHaveLength(1);
  });

  it('enforces names, duplicate session ids, recipe limit, rename, delete, and clone semantics', () => {
    sessionState.sessions.set('s1', { toInfo: () => ({
      id: 's1',
      environmentId: null,
      label: 'Local',
      workingDir: 'C:/repo/local',
      state: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
      cliTool: 'claude',
    }) });
    const first = captureWorkspaceRecipe({
      name: 'One',
      sessionIds: ['s1'],
      layout: { mode: 'split', activeSessionIndex: 0, split: { type: 'leaf', sessionIndex: 0 } },
    });
    expect(() => captureWorkspaceRecipe({
      name: 'one',
      sessionIds: ['s1'],
      layout: { mode: 'split', activeSessionIndex: 0, split: { type: 'leaf', sessionIndex: 0 } },
    })).toThrow(/already exists/);
    expect(() => captureWorkspaceRecipe({
      name: 'Two',
      sessionIds: ['s1', 's1'],
      layout: { mode: 'split', activeSessionIndex: 0, split: { type: 'leaf', sessionIndex: 0 } },
    })).toThrow(/unique/);

    const renamed = renameWorkspaceRecipe(first.id, 'Renamed');
    expect(renamed.name).toBe('Renamed');
    const listed = listWorkspaceRecipes();
    listed[0].name = 'Mutated';
    expect(listWorkspaceRecipes()[0].name).toBe('Renamed');
    deleteWorkspaceRecipe(first.id);
    expect(listWorkspaceRecipes()).toEqual([]);
    expect(getDb().launchSnapshots['snap-1']).toBeTruthy();
  });

  it('prepareOpen validates all selections before returning safe whitelisted launch options', async () => {
    const localDir = await fsp.mkdtemp(path.join(electronState.userData, 'local-'));
    getDb().environments.push({
      id: 'env-local',
      name: 'Local',
      type: 'local',
      config: '{}',
      env_vars: '{}',
      auth_mode: null,
      model: null,
      small_model: null,
      sort_order: 0,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    }, {
      id: 'env-ssh',
      name: 'SSH',
      type: 'ssh',
      config: '{}',
      env_vars: '{}',
      auth_mode: null,
      model: null,
      small_model: null,
      sort_order: 1,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    getDb().workspaceRecipes.push(recipe({
      sessions: [
        recipe().sessions[0],
        { label: 'Remote', workingDir: '/remote', environmentId: 'env-ssh', cliTool: 'claude' },
      ],
      layout: {
        mode: 'canvas',
        activeSessionIndex: 1,
        split: null,
        canvas: { panels: [{ sessionIndex: 1, x: 0, y: 0, width: 500, height: 300, z: 1 }], viewport: { x: 0, y: 0 }, focusedSessionIndex: 1 },
      },
    }));

    const failed = await prepareOpenWorkspaceRecipe({
      recipeId: 'recipe-1',
      selections: [
        { sessionIndex: 0, workingDir: path.join(electronState.userData, 'missing'), environmentId: 'env-local' },
        { sessionIndex: 0, workingDir: localDir },
        { sessionIndex: 9, workingDir: localDir },
        { sessionIndex: 1, workingDir: '/remote/path', environmentId: 'missing-env' },
      ],
    });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.failures.map(f => f.error)).toEqual(expect.arrayContaining([
      'Working directory was not found',
      'Session slot was selected more than once',
      'Session slot is invalid',
      'Environment was not found',
    ]));

    const prepared = await prepareOpenWorkspaceRecipe({
      recipeId: 'recipe-1',
      selections: [
        { sessionIndex: 0, workingDir: localDir },
        { sessionIndex: 1, workingDir: 'coder-workspace::/repo', environmentId: 'env-ssh' },
      ],
    });
    expect(prepared.ok).toBe(true);
    if (prepared.ok) {
      expect(prepared.plan).toMatchObject({ recipeId: 'recipe-1', name: 'Morning', sessionCount: 2 });
      expect(prepared.plan.sessions).toEqual([
        { sessionIndex: 0, options: { label: 'API', workingDir: localDir, cliTool: 'codex', launchSnapshotId: 'snap-1' } },
        { sessionIndex: 1, options: { label: 'Remote', workingDir: 'coder-workspace::/repo', environmentId: 'env-ssh', cliTool: 'claude' } },
      ]);
      expect(JSON.stringify(prepared.plan)).not.toContain('TOKEN');
    }
  });

  it('prepareOpen preflights invalid launch snapshots without producing a plan', async () => {
    getDb().workspaceRecipes.push(recipe());
    getDb().launchSnapshots = {};
    const prepared = await prepareOpenWorkspaceRecipe({
      recipeId: 'recipe-1',
      selections: [{ sessionIndex: 0, workingDir: electronState.userData }],
    });
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) expect(prepared.failures[0].error).toBe('Saved launch settings are unavailable');
  });
});
