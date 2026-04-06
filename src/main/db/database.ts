import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

export interface SavedSession {
  workingDir: string;
  label: string;
  environmentId?: string;
}

export interface SavedWorkspace {
  sessions: SavedSession[];
  activeIndex: number;
}

export interface GitProviderRow {
  id: string;
  name: string;
  type: 'gitea' | 'ado';
  baseUrl: string;
  organization: string | null;
  token: string;
  created_at: string;
  updated_at: string;
}

export interface DbData {
  environments: EnvironmentRow[];
  sessions: SessionRow[];
  config: Record<string, string>;
  defaultEnvVars: Record<string, string>;
  defaultCliFlags: string[];
  savedWorkspace: SavedWorkspace | null;
  gitProviders: GitProviderRow[];
}

export interface EnvironmentRow {
  id: string;
  name: string;
  type: 'local' | 'ssh' | 'coder';
  config: string;
  env_vars: string; // JSON-encoded Record<string, string>
  auth_mode: string | null;
  api_key_enc: string | null;
  model: string | null;
  small_model: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
  id: string;
  environment_id: string | null;
  label: string;
  working_dir: string;
  state: string;
  auth_mode: string | null;
  api_key_enc: string | null;
  model: string | null;
  small_model: string | null;
  pid: number | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  last_active_at: string | null;
}

let data: DbData | null = null;
let dbPath: string | null = null;

function getDbPath(): string {
  if (!dbPath) {
    const dataDir = app.getPath('userData');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    dbPath = path.join(dataDir, 'data.json');
  }
  return dbPath;
}

export function getDb(): DbData {
  if (!data) {
    const filePath = getDbPath();
    if (fs.existsSync(filePath)) {
      try {
        const loaded = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        // Backfill missing fields from older data files
        const envs = (loaded.environments || []).map((e: Record<string, unknown>) => ({
          ...e,
          env_vars: e.env_vars || '{}',
        }));
        data = {
          environments: envs,
          sessions: loaded.sessions || [],
          config: loaded.config || {},
          defaultEnvVars: loaded.defaultEnvVars || {},
          defaultCliFlags: loaded.defaultCliFlags || [],
          savedWorkspace: loaded.savedWorkspace || null,
          gitProviders: loaded.gitProviders || [],
        };
      } catch {
        data = { environments: [], sessions: [], config: {}, defaultEnvVars: {}, defaultCliFlags: [], savedWorkspace: null, gitProviders: [] };
      }
    } else {
      data = { environments: [], sessions: [], config: {}, defaultEnvVars: {}, defaultCliFlags: [], savedWorkspace: null, gitProviders: [] };
    }
  }
  return data;
}

export function saveDb(): void {
  if (data) {
    fs.writeFileSync(getDbPath(), JSON.stringify(data, null, 2), 'utf-8');
  }
}

export function closeDb(): void {
  saveDb();
  data = null;
}
