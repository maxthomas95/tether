import type { SavedCanvas } from '../../shared/canvas-types';
import type {
  RecipeSplitNode,
  WorkspaceRecipe,
  WorkspaceRecipeLayout,
  WorkspaceRecipeSession,
} from '../../shared/workspace-recipes';
import { MAX_RECIPE_NAME_LENGTH, MAX_RECIPE_SESSIONS, MAX_WORKSPACE_RECIPES } from '../../shared/workspace-recipes';
import type { CliToolId } from '../../shared/cli-tools';

const CLI_TOOLS: ReadonlySet<CliToolId> = new Set(['claude', 'codex', 'copilot', 'opencode', 'custom']);
const MAX_SPLIT_DEPTH = 6;
const MIN_RATIO = 0.15;
const MAX_RATIO = 0.85;
const MAX_CANVAS_COORD = 100_000;
const MAX_CANVAS_SIZE = 10_000;

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
  if (typeof input.environmentId === 'string' && input.environmentId) out.environmentId = input.environmentId;
  if (cliTool === 'custom' && typeof input.customCliBinary === 'string' && input.customCliBinary.trim()) {
    out.customCliBinary = input.customCliBinary;
  }
  if (input.helmEnabled === true) out.helmEnabled = true;
  if (typeof input.launchSnapshotId === 'string' && input.launchSnapshotId) out.launchSnapshotId = input.launchSnapshotId;
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
      width: assertFiniteBounded(panel.width, 'Canvas width', 1, MAX_CANVAS_SIZE),
      height: assertFiniteBounded(panel.height, 'Canvas height', 1, MAX_CANVAS_SIZE),
      z: assertFiniteBounded(panel.z, 'Canvas z', -MAX_CANVAS_COORD, MAX_CANVAS_COORD),
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
  const names = new Set<string>();
  for (const item of value) {
    if (out.length >= MAX_WORKSPACE_RECIPES) break;
    try {
      const recipe = normalizeWorkspaceRecipe(item);
      const nameKey = recipe.name.toLocaleLowerCase();
      if (names.has(nameKey)) continue;
      names.add(nameKey);
      out.push(recipe);
    } catch {
      // Invalid persisted recipes are discarded during migration while valid
      // records remain available.
    }
  }
  return out;
}
