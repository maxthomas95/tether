import fs from 'node:fs/promises';
import { v4 as uuidv4 } from 'uuid';
import { getDb, saveDb } from '../db/database';
import { getEnvironment } from '../db/environment-repo';
import { sessionManager } from '../session/session-manager';
import { readLaunchIntent } from '../session/launch-snapshots';
import type {
  CaptureWorkspaceRecipe,
  PrepareWorkspaceRecipe,
  PreparedWorkspaceRecipe,
  WorkspaceRecipe,
  WorkspaceRecipeFailure,
  WorkspaceRecipeOpenPlan,
  WorkspaceRecipeSelection,
  WorkspaceRecipeSession,
} from '../../shared/workspace-recipes';
import { MAX_RECIPE_SESSIONS, MAX_WORKSPACE_RECIPES } from '../../shared/workspace-recipes';
import {
  normalizeRecipeLayout,
  normalizeRecipeName,
  normalizeWorkspaceRecipe,
} from './normalize';
import type { SessionInfo } from '../../shared/types';

function cloneRecipe(recipe: WorkspaceRecipe): WorkspaceRecipe {
  return JSON.parse(JSON.stringify(recipe)) as WorkspaceRecipe;
}

function findRecipe(id: string): WorkspaceRecipe | undefined {
  return getDb().workspaceRecipes.find(recipe => recipe.id === id);
}

function assertUniqueName(name: string, ignoreId?: string): void {
  const key = name.toLocaleLowerCase();
  if (getDb().workspaceRecipes.some(recipe => recipe.id !== ignoreId && recipe.name.toLocaleLowerCase() === key)) {
    throw new Error('A workspace recipe with that name already exists');
  }
}

function assertRecipeLimit(): void {
  if (getDb().workspaceRecipes.length >= MAX_WORKSPACE_RECIPES) {
    throw new Error(`Workspace recipes are limited to ${MAX_WORKSPACE_RECIPES}`);
  }
}

function assertUniqueSessionIds(sessionIds: unknown): asserts sessionIds is string[] {
  if (!Array.isArray(sessionIds)) throw new Error('Recipe session ids are invalid');
  if (sessionIds.length < 1 || sessionIds.length > MAX_RECIPE_SESSIONS) {
    throw new Error(`Recipes must contain between 1 and ${MAX_RECIPE_SESSIONS} sessions`);
  }
  const seen = new Set<string>();
  for (const id of sessionIds) {
    if (typeof id !== 'string' || !id) throw new Error('Recipe session id is invalid');
    if (seen.has(id)) throw new Error('Recipe session ids must be unique');
    seen.add(id);
  }
}

function projectSession(info: SessionInfo): WorkspaceRecipeSession {
  const cliTool = info.cliTool ?? 'claude';
  const out: WorkspaceRecipeSession = {
    label: info.label,
    workingDir: info.workingDir,
    cliTool,
  };
  if (info.environmentId) out.environmentId = info.environmentId;
  if (cliTool === 'custom' && info.customCliBinary) out.customCliBinary = info.customCliBinary;
  if (info.helmEnabled) out.helmEnabled = true;
  if (info.launchSnapshotId) {
    readLaunchIntent(info.launchSnapshotId);
    out.launchSnapshotId = info.launchSnapshotId;
  }
  return out;
}

export function listWorkspaceRecipes(): WorkspaceRecipe[] {
  return getDb().workspaceRecipes.map(cloneRecipe);
}

export function captureWorkspaceRecipe(options: CaptureWorkspaceRecipe): WorkspaceRecipe {
  const name = normalizeRecipeName(options.name);
  assertUniqueName(name);
  assertRecipeLimit();
  assertUniqueSessionIds(options.sessionIds);

  const sessions: WorkspaceRecipeSession[] = [];
  const missing: string[] = [];
  for (const id of options.sessionIds) {
    const live = sessionManager.getSession(id);
    if (!live) {
      missing.push(id);
      continue;
    }
    sessions.push(projectSession(live.toInfo()));
  }
  if (missing.length > 0) {
    throw new Error('One or more sessions are no longer running');
  }

  const layout = normalizeRecipeLayout(options.layout, sessions.length);
  const now = new Date().toISOString();
  const recipe = normalizeWorkspaceRecipe({
    id: uuidv4(),
    version: 1,
    name,
    createdAt: now,
    updatedAt: now,
    sessions,
    layout,
  });
  getDb().workspaceRecipes.push(recipe);
  saveDb();
  return cloneRecipe(recipe);
}

export function renameWorkspaceRecipe(id: string, nameInput: string): WorkspaceRecipe {
  const recipe = findRecipe(id);
  if (!recipe) throw new Error('Workspace recipe not found');
  const name = normalizeRecipeName(nameInput);
  assertUniqueName(name, id);
  recipe.name = name;
  recipe.updatedAt = new Date().toISOString();
  saveDb();
  return cloneRecipe(recipe);
}

export function deleteWorkspaceRecipe(id: string): void {
  const db = getDb();
  const before = db.workspaceRecipes.length;
  db.workspaceRecipes = db.workspaceRecipes.filter(recipe => recipe.id !== id);
  if (db.workspaceRecipes.length === before) throw new Error('Workspace recipe not found');
  saveDb();
}

function getSelectionFailure(recipe: WorkspaceRecipe, selection: WorkspaceRecipeSelection, seen: Set<number>): WorkspaceRecipeFailure | null {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) {
    return { sessionIndex: -1, label: 'Session ?', error: 'Session selection is invalid' };
  }
  const index = selection.sessionIndex;
  const label = Number.isInteger(index) && index >= 0 && index < recipe.sessions.length
    ? recipe.sessions[index].label
    : `Session ${typeof index === 'number' ? index + 1 : '?'}`;
  if (!Number.isInteger(index) || index < 0 || index >= recipe.sessions.length) {
    return { sessionIndex: Number.isInteger(index) ? index : -1, label, error: 'Session slot is invalid' };
  }
  if (seen.has(index)) return { sessionIndex: index, label, error: 'Session slot was selected more than once' };
  seen.add(index);
  if (typeof selection.workingDir !== 'string' || !selection.workingDir.trim()) {
    return { sessionIndex: index, label, error: 'Working directory is required' };
  }
  if (Object.prototype.hasOwnProperty.call(selection, 'environmentId') && selection.environmentId !== undefined && typeof selection.environmentId !== 'string') {
    return { sessionIndex: index, label, error: 'Environment is invalid' };
  }
  return null;
}

async function validateWorkingDirectory(environmentId: string | undefined, workingDir: string): Promise<string | null> {
  if (!environmentId) {
    try {
      const stat = await fs.stat(workingDir);
      return stat.isDirectory() ? null : 'Working directory is not a folder';
    } catch {
      return 'Working directory was not found';
    }
  }
  const env = getEnvironment(environmentId);
  if (!env) return 'Environment was not found';
  if (env.type !== 'local' && env.type !== 'ssh' && env.type !== 'coder') return 'Environment type is unsupported';
  if (env.type === 'local') {
    try {
      const stat = await fs.stat(workingDir);
      return stat.isDirectory() ? null : 'Working directory is not a folder';
    } catch {
      return 'Working directory was not found';
    }
  }
  return null;
}

function validateSnapshot(recipe: WorkspaceRecipe, sessionIndex: number): WorkspaceRecipeFailure | null {
  const session = recipe.sessions[sessionIndex];
  if (!session.launchSnapshotId) return null;
  try {
    readLaunchIntent(session.launchSnapshotId);
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Saved launch settings are unavailable';
    return { sessionIndex, label: session.label, error: message };
  }
}

export async function prepareOpenWorkspaceRecipe(options: PrepareWorkspaceRecipe): Promise<PreparedWorkspaceRecipe> {
  const recipe = findRecipe(options.recipeId);
  if (!recipe) throw new Error('Workspace recipe not found');
  if (!Array.isArray(options.selections) || options.selections.length < 1 || options.selections.length > MAX_RECIPE_SESSIONS) {
    return { ok: false, failures: [{ sessionIndex: -1, label: recipe.name, error: 'Select at least one session' }] };
  }

  const failures: WorkspaceRecipeFailure[] = [];
  const seen = new Set<number>();
  const selected: Array<{ selection: WorkspaceRecipeSelection; saved: WorkspaceRecipeSession }> = [];
  for (const selection of options.selections) {
    const shapeFailure = getSelectionFailure(recipe, selection, seen);
    if (shapeFailure) {
      failures.push(shapeFailure);
      continue;
    }
    const snapshotFailure = validateSnapshot(recipe, selection.sessionIndex);
    if (snapshotFailure) failures.push(snapshotFailure);
    const workingDirFailure = await validateWorkingDirectory(selection.environmentId, selection.workingDir);
    if (workingDirFailure) {
      failures.push({ sessionIndex: selection.sessionIndex, label: recipe.sessions[selection.sessionIndex].label, error: workingDirFailure });
    }
    selected.push({ selection, saved: recipe.sessions[selection.sessionIndex] });
  }

  if (failures.length > 0) return { ok: false, failures };

  const plan: WorkspaceRecipeOpenPlan = {
    recipeId: recipe.id,
    name: recipe.name,
    sessionCount: recipe.sessions.length,
    layout: cloneRecipe(recipe).layout,
    sessions: selected.map(({ selection, saved }) => ({
      sessionIndex: selection.sessionIndex,
      options: {
        label: saved.label,
        workingDir: selection.workingDir,
        cliTool: saved.cliTool,
        ...(selection.environmentId ? { environmentId: selection.environmentId } : {}),
        ...(saved.customCliBinary ? { customCliBinary: saved.customCliBinary } : {}),
        ...(saved.helmEnabled ? { helmEnabled: true } : {}),
        ...(saved.launchSnapshotId ? { launchSnapshotId: saved.launchSnapshotId } : {}),
      },
    })),
  };
  return { ok: true, plan };
}
