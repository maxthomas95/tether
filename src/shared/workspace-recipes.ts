import type { SavedCanvas } from './canvas-types';
import type { CliToolId } from './cli-tools';

export const MAX_RECIPE_SESSIONS = 64;
export const MAX_WORKSPACE_RECIPES = 128;
export const MAX_RECIPE_NAME_LENGTH = 80;

/** Launch templates carry display metadata and protected references only. */
export interface WorkspaceRecipeSession {
  label: string;
  workingDir: string;
  environmentId?: string;
  cliTool: CliToolId;
  customCliBinary?: string;
  helmEnabled?: boolean;
  launchSnapshotId?: string;
}

export type RecipeSplitNode =
  | { type: 'leaf'; sessionIndex: number | null }
  | { type: 'split'; direction: 'horizontal' | 'vertical'; ratio: number; children: [RecipeSplitNode, RecipeSplitNode] };

export interface WorkspaceRecipeLayout {
  mode: 'split' | 'canvas';
  activeSessionIndex: number;
  split: RecipeSplitNode | null;
  canvas?: SavedCanvas;
}

export interface WorkspaceRecipe {
  id: string;
  version: 1;
  name: string;
  createdAt: string;
  updatedAt: string;
  sessions: WorkspaceRecipeSession[];
  layout: WorkspaceRecipeLayout;
}

export interface CaptureWorkspaceRecipe {
  name: string;
  /** Ordered live-session ids; main reads their authoritative metadata. */
  sessionIds: string[];
  layout: WorkspaceRecipeLayout;
}

export interface WorkspaceRecipeSelection {
  sessionIndex: number;
  workingDir: string;
  /** Omitted means Local PC, even if the saved slot used a remote target. */
  environmentId?: string;
}

export interface PrepareWorkspaceRecipe {
  recipeId: string;
  selections: WorkspaceRecipeSelection[];
}

export interface WorkspaceRecipeFailure {
  sessionIndex: number;
  label: string;
  error: string;
}

export interface WorkspaceRecipeOpenPlan {
  recipeId: string;
  name: string;
  sessionCount: number;
  layout: WorkspaceRecipeLayout;
  sessions: Array<{ sessionIndex: number; options: WorkspaceRecipeSession }>;
}

export type PreparedWorkspaceRecipe =
  | { ok: true; plan: WorkspaceRecipeOpenPlan }
  | { ok: false; failures: WorkspaceRecipeFailure[] };

export interface WorkspaceRecipesAPI {
  list(): Promise<WorkspaceRecipe[]>;
  capture(options: CaptureWorkspaceRecipe): Promise<WorkspaceRecipe>;
  rename(id: string, name: string): Promise<WorkspaceRecipe>;
  delete(id: string): Promise<void>;
  prepareOpen(options: PrepareWorkspaceRecipe): Promise<PreparedWorkspaceRecipe>;
}

export interface WorkspaceRecipeLaunchResult {
  /** Original slot indexes remain stable across partial launches and retries. */
  sessionIds: Array<string | null>;
  failures: WorkspaceRecipeFailure[];
  cancelled: boolean;
}
