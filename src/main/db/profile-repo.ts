import { v4 as uuidv4 } from 'uuid';
import { getDb, saveDb } from './database';
import type { LaunchProfileRow } from './database';
import type { CliToolId } from '../../shared/cli-tools';
import { decryptEnvVarsJson, encryptEnvVarsRecord } from './secret-storage';

export type { LaunchProfileRow };

export interface CreateProfileInput {
  name: string;
  envVars?: Record<string, string>;
  cliFlagsPerTool?: Partial<Record<CliToolId, string[]>>;
  cliFlags?: string[];
  isDefault?: boolean;
}

function toPublicRow(row: LaunchProfileRow): LaunchProfileRow {
  return { ...row, env_vars: decryptEnvVarsJson(row.env_vars || '{}') };
}

function findProfileRow(id: string): LaunchProfileRow | undefined {
  return getDb().launchProfiles.find(p => p.id === id);
}

export function listProfiles(): LaunchProfileRow[] {
  return getDb().launchProfiles
    .sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at))
    .map(toPublicRow);
}

export function getProfile(id: string): LaunchProfileRow | undefined {
  const row = findProfileRow(id);
  return row ? toPublicRow(row) : undefined;
}

export function createProfile(input: CreateProfileInput): LaunchProfileRow {
  const now = new Date().toISOString();
  if (input.isDefault) {
    for (const p of getDb().launchProfiles) {
      p.is_default = false;
    }
  }
  const profile: LaunchProfileRow = {
    id: uuidv4(),
    name: input.name,
    env_vars: JSON.stringify(encryptEnvVarsRecord(input.envVars || {})),
    cli_flags: JSON.stringify(input.cliFlags || []),
    cli_flags_per_tool: JSON.stringify(input.cliFlagsPerTool || (input.cliFlags ? { claude: input.cliFlags } : {})),
    is_default: input.isDefault || false,
    sort_order: 0,
    created_at: now,
    updated_at: now,
  };
  getDb().launchProfiles.push(profile);
  saveDb();
  return toPublicRow(profile);
}

export function updateProfile(id: string, updates: Partial<CreateProfileInput>): void {
  const profile = findProfileRow(id);
  if (!profile) return;
  if (updates.isDefault) {
    for (const p of getDb().launchProfiles) {
      p.is_default = false;
    }
  }
  if (updates.name !== undefined) profile.name = updates.name;
  if (updates.envVars !== undefined) profile.env_vars = JSON.stringify(encryptEnvVarsRecord(updates.envVars));
  if (updates.cliFlags !== undefined) profile.cli_flags = JSON.stringify(updates.cliFlags);
  if (updates.cliFlagsPerTool !== undefined) profile.cli_flags_per_tool = JSON.stringify(updates.cliFlagsPerTool);
  if (updates.isDefault !== undefined) profile.is_default = updates.isDefault;
  profile.updated_at = new Date().toISOString();
  saveDb();
}

export function deleteProfile(id: string): void {
  const db = getDb();
  db.launchProfiles = db.launchProfiles.filter(p => p.id !== id);
  saveDb();
}
