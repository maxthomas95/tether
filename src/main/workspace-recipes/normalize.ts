import type { SavedCanvas } from '../../shared/canvas-types';
import type {
  RecipeSplitNode,
  WorkspaceRecipe,
  WorkspaceRecipeLayout,
  WorkspaceRecipeSession,
} from '../../shared/workspace-recipes';
import { MAX_RECIPE_NAME_LENGTH, MAX_RECIPE_SESSIONS, MAX_WORKSPACE_RECIPES } from '../../shared/workspace-recipes';
import { CLI_TOOL_REGISTRY, type CliToolId } from '../../shared/cli-tools';

const CLI_TOOLS: ReadonlySet<string> = new Set(Object.keys(CLI_TOOL_REGISTRY));
const MAX_SPLIT_DEPTH = 6;
const MIN_RATIO = 0.15;
const MAX_RATIO = 0.85;
const MAX_CANVAS_COORD = 100_000;
const MIN_CANVAS_WIDTH = 280;
const MAX_CANVAS_WIDTH = 4096;
const MIN_CANVAS_HEIGHT = 180;
const MAX_CANVAS_HEIGHT = 4096;
const MIN_CANVAS_Z = 0;
const MAX_CANVAS_Z = 100_000;

export function normalizeRecipeName(name: unknown): string {
  if (typeof name !== 'string') throw new Error('Recipe name is required');
  const trimmed = name.trim();
  if (trimmed.length < 1) throw new Error('Recipe name is required');
  if (trimmed.length > MAX_RECIPE_NAME_LENGTH) {
    throw new Error(`Recipe name must be ${MAX_RECIPE_NAME_LENGTH} characters or fewer`);
  }
  return trimmed;
}

export function normalizeRecipeSession(value: unknown): WorkspaceRecipeSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Recipe session is invalid');
  }
  const input = value as Record<string, unknown>;
  if (typeof input.label !== 'string') throw new Error('Recipe session label is invalid');
  const label = input.label.trim() || 'Untitled';
  if (typeof input.workingDir !== 'string' || !input.workingDir.trim()) {
    throw new Error('Recipe session working directory is invalid');
  }
  const cliTool = input.cliTool === undefined ? 'claude' : input.cliTool;
  if (typeof cliTool !== 'string' || !CLI_TOOLS.has(cliTool as CliToolId)) {
    throw new Error('Recipe session CLI tool is invalid');
  }
  const out: WorkspaceRecipeSession = {
    label,
    workingDir: input.workingDir,
    cliTool: cliTool as CliToolId,
  };
  if (Object.prototype.hasOwnProperty.call(input, 'environmentId')) {
    if (typeof input.environmentId !== 'string' || !input.environmentId) throw new Error('Recipe session environment is invalid');
    out.environmentId = input.environmentId;
  }
  if (cliTool === 'custom') {
    if (typeof input.customCliBinary !== 'string' || !input.customCliBinary.trim()) throw new Error('Custom recipe session binary is invalid');
    out.customCliBinary = input.customCliBinary;
  } else if (Object.prototype.hasOwnProperty.call(input, 'customCliBinary') && input.customCliBinary !== undefined) {
    throw new Error('Recipe session custom binary is invalid');
  }
  if (Object.prototype.hasOwnProperty.call(input, 'helmEnabled')) {
    if (typeof input.helmEnabled !== 'boolean') throw new Error('Recipe session Helm flag is invalid');
    if (input.helmEnabled) out.helmEnabled = true;
  }
  if (Object.prototype.hasOwnProperty.call(input, 'launchSnapshotId')) {
    if (typeof input.launchSnapshotId !== 'string' || !input.launchSnapshotId) throw new Error('Recipe session launch settings are invalid');
    out.launchSnapshotId = input.launchSnapshotId;
  }
  return out;
}

function normalizeSplitNode(value: unknown, sessionCount: number, depth = 0): { node: RecipeSplitNode; leaves: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Split layout is invalid');
  if (depth > MAX_SPLIT_DEPTH) throw new Error('Split layout is too deep');
  const input = value as Record<string, unknown>;
  if (input.type === 'leaf') {
    const sessionIndex = input.sessionIndex;
    if (sessionIndex !== null && (!Number.isInteger(sessionIndex) || (sessionIndex as number) < 0 || (sessionIndex as number) >= sessionCount)) {
      throw new Error('Split layout references an invalid session');
    }
    return { node: { type: 'leaf', sessionIndex: sessionIndex as number | null }, leaves: 1 };
  }
  if (input.type !== 'split') throw new Error('Split layout is invalid');
  if (input.direction !== 'horizontal' && input.direction !== 'vertical') throw new Error('Split direction is invalid');
  if (!Number.isFinite(input.ratio) || (input.ratio as number) < MIN_RATIO || (input.ratio as number) > MAX_RATIO) {
    throw new Error('Split ratio is invalid');
  }
  if (!Array.isArray(input.children) || input.children.length !== 2) throw new Error('Split children are invalid');
  const left = normalizeSplitNode(input.children[0], sessionCount, depth + 1);
  const right = normalizeSplitNode(input.children[1], sessionCount, depth + 1);
  const leaves = left.leaves + right.leaves;
  if (leaves > 4) throw new Error('Split layout can contain at most four panes');
  return {
    node: {
      type: 'split',
      direction: input.direction,
      ratio: input.ratio as number,
      children: [left.node, right.node],
    },
    leaves,
  };
}

function assertFiniteBounded(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isFinite(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${label} is invalid`);
  }
  return value as number;
}

function normalizeCanvas(value: unknown, sessionCount: number): SavedCanvas | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Canvas layout is invalid');
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.panels) || input.panels.length > MAX_RECIPE_SESSIONS) throw new Error('Canvas panels are invalid');
  const seen = new Set<number>();
  const panels = input.panels.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Canvas panel is invalid');
    const panel = raw as Record<string, unknown>;
    if (!Number.isInteger(panel.sessionIndex) || (panel.sessionIndex as number) < 0 || (panel.sessionIndex as number) >= sessionCount) {
      throw new Error('Canvas panel references an invalid session');
    }
    const sessionIndex = panel.sessionIndex as number;
    if (seen.has(sessionIndex)) throw new Error('Canvas panel references a duplicate session');
    seen.add(sessionIndex);
    return {
      sessionIndex,
      x: assertFiniteBounded(panel.x, 'Canvas x', -MAX_CANVAS_COORD, MAX_CANVAS_COORD),
      y: assertFiniteBounded(panel.y, 'Canvas y', -MAX_CANVAS_COORD, MAX_CANVAS_COORD),
      width: assertFiniteBounded(panel.width, 'Canvas width', MIN_CANVAS_WIDTH, MAX_CANVAS_WIDTH),
      height: assertFiniteBounded(panel.height, 'Canvas height', MIN_CANVAS_HEIGHT, MAX_CANVAS_HEIGHT),
      z: assertFiniteBounded(panel.z, 'Canvas z', MIN_CANVAS_Z, MAX_CANVAS_Z),
    };
  });
  const viewport = input.viewport && typeof input.viewport === 'object' && !Array.isArray(input.viewport)
    ? input.viewport as Record<string, unknown>
    : null;
  if (!viewport) throw new Error('Canvas viewport is invalid');
  const focused = input.focusedSessionIndex;
  if (focused !== null && focused !== undefined && (!Number.isInteger(focused) || (focused as number) < 0 || (focused as number) >= sessionCount)) {
    throw new Error('Canvas focus references an invalid session');
  }
  return {
    panels,
    viewport: {
      x: assertFiniteBounded(viewport.x, 'Canvas viewport x', -MAX_CANVAS_COORD, MAX_CANVAS_COORD),
      y: assertFiniteBounded(viewport.y, 'Canvas viewport y', -MAX_CANVAS_COORD, MAX_CANVAS_COORD),
    },
    focusedSessionIndex: focused === undefined ? null : focused as number | null,
  };
}

export function normalizeRecipeLayout(value: unknown, sessionCount: number): WorkspaceRecipeLayout {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Recipe layout is invalid');
  if (sessionCount < 1 || sessionCount > MAX_RECIPE_SESSIONS) throw new Error('Recipe session count is invalid');
  const input = value as Record<string, unknown>;
  if (input.mode !== 'split' && input.mode !== 'canvas') throw new Error('Recipe layout mode is invalid');
  if (!Number.isInteger(input.activeSessionIndex) || (input.activeSessionIndex as number) < 0 || (input.activeSessionIndex as number) >= sessionCount) {
    throw new Error('Recipe active session is invalid');
  }
  const split = input.split === null || input.split === undefined
    ? null
    : normalizeSplitNode(input.split, sessionCount).node;
  const canvas = normalizeCanvas(input.canvas, sessionCount);
  return {
    mode: input.mode,
    activeSessionIndex: input.activeSessionIndex as number,
    split,
    ...(canvas ? { canvas } : {}),
  };
}

export function normalizeWorkspaceRecipe(value: unknown): WorkspaceRecipe {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Workspace recipe is invalid');
  const input = value as Record<string, unknown>;
  if (input.version !== 1) throw new Error('Workspace recipe version is invalid');
  if (typeof input.id !== 'string' || !input.id) throw new Error('Workspace recipe id is invalid');
  if (typeof input.createdAt !== 'string' || Number.isNaN(Date.parse(input.createdAt))) throw new Error('Workspace recipe createdAt is invalid');
  if (typeof input.updatedAt !== 'string' || Number.isNaN(Date.parse(input.updatedAt))) throw new Error('Workspace recipe updatedAt is invalid');
  if (!Array.isArray(input.sessions) || input.sessions.length < 1 || input.sessions.length > MAX_RECIPE_SESSIONS) {
    throw new Error('Workspace recipe sessions are invalid');
  }
  const sessions = input.sessions.map(normalizeRecipeSession);
  return {
    id: input.id,
    version: 1,
    name: normalizeRecipeName(input.name),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    sessions,
    layout: normalizeRecipeLayout(input.layout, sessions.length),
  };
}

export function normalizeWorkspaceRecipes(value: unknown): WorkspaceRecipe[] {
  if (!Array.isArray(value)) return [];
  const out: WorkspaceRecipe[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const item of value) {
    if (out.length >= MAX_WORKSPACE_RECIPES) break;
    try {
      const recipe = normalizeWorkspaceRecipe(item);
      if (ids.has(recipe.id)) continue;
      const nameKey = recipe.name.toLocaleLowerCase();
      if (names.has(nameKey)) continue;
      ids.add(recipe.id);
      names.add(nameKey);
      out.push(recipe);
    } catch {
      // Invalid persisted recipes are discarded during migration while valid
      // records remain available.
    }
  }
  return out;
}
