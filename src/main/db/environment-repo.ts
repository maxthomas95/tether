import { v4 as uuidv4 } from 'uuid';
import { getDb, saveDb } from './database';
import type { EnvironmentRow } from './database';

export type { EnvironmentRow };

export interface CreateEnvironmentInput {
  name: string;
  type: 'local' | 'ssh' | 'coder';
  config?: Record<string, unknown>;
  envVars?: Record<string, string>;
  auth_mode?: string;
  model?: string;
  small_model?: string;
}

export function listEnvironments(): EnvironmentRow[] {
  return getDb().environments.sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at));
}

export function getEnvironment(id: string): EnvironmentRow | undefined {
  return getDb().environments.find(e => e.id === id);
}

export function createEnvironment(input: CreateEnvironmentInput): EnvironmentRow {
  const now = new Date().toISOString();
  const env: EnvironmentRow = {
    id: uuidv4(),
    name: input.name,
    type: input.type,
    config: JSON.stringify(input.config || {}),
    env_vars: JSON.stringify(input.envVars || {}),
    auth_mode: input.auth_mode || null,
    model: input.model || null,
    small_model: input.small_model || null,
    sort_order: 0,
    created_at: now,
    updated_at: now,
  };
  getDb().environments.push(env);
  saveDb();
  return env;
}

export function updateEnvironment(id: string, updates: Partial<CreateEnvironmentInput>): void {
  const env = getEnvironment(id);
  if (!env) return;
  if (updates.name !== undefined) env.name = updates.name;
  if (updates.type !== undefined) env.type = updates.type;
  if (updates.config !== undefined) env.config = JSON.stringify(updates.config);
  if (updates.envVars !== undefined) env.env_vars = JSON.stringify(updates.envVars);
  if (updates.auth_mode !== undefined) env.auth_mode = updates.auth_mode;
  if (updates.model !== undefined) env.model = updates.model;
  if (updates.small_model !== undefined) env.small_model = updates.small_model;
  env.updated_at = new Date().toISOString();
  saveDb();
}

export function deleteEnvironment(id: string): void {
  const db = getDb();
  db.environments = db.environments.filter(e => e.id !== id);
  saveDb();
}

export function ensureDefaultLocalEnvironment(): EnvironmentRow {
  const existing = listEnvironments().find(e => e.type === 'local');
  if (existing) return existing;
  return createEnvironment({ name: 'Local', type: 'local' });
}
