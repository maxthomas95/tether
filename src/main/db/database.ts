import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import type { CliToolId } from '../../shared/cli-tools';
import type { RepoGroupPref } from '../../shared/types';

export interface SavedSession {
  workingDir: string;
  label: string;
  environmentId?: string;
  /** CLI tool used for this session (defaults to 'claude'). */
  cliTool?: string;
  /** Binary name for custom CLI tool. */
  customCliBinary?: string;
  /** Tool-native session id to resume on next launch. */
  toolSessionId?: string;
  /** Legacy UUID of the Claude conversation to resume on next launch. */
  claudeSessionId?: string;
  /** When true, re-wire the Helm MCP on next launch of this session. */
  helmEnabled?: boolean;
  /** Parent Helm session id for dispatched children — drives the 🪝 badge. */
  parentSessionId?: string;
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

export interface LaunchProfileRow {
  id: string;
  name: string;
  env_vars: string;       // JSON-encoded Record<string, string>
  cli_flags: string;      // JSON-encoded string[]
  cli_flags_per_tool: string; // JSON-encoded Partial<Record<CliToolId, string[]>>
  is_default: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface KnownHostEntry {
  id: string;
  hostKey: string;        // "host:port"
  keyHash: string;        // sha256 hex digest (lowercase)
  keyType: string;        // best-effort; 'unknown' from hostVerifier alone
  trustedAt: string;      // ISO timestamp
  firstSeen: string;      // ISO timestamp (same as trustedAt for TOFU)
}

export interface DbData {
  environments: EnvironmentRow[];
  sessions: SessionRow[];
  launchProfiles: LaunchProfileRow[];
  config: Record<string, string>;
  defaultEnvVars: Record<string, string>;
  defaultCliFlags: string[];
  defaultCliFlagsPerTool: Partial<Record<CliToolId, string[]>>;
  savedWorkspace: SavedWorkspace | null;
  gitProviders: GitProviderRow[];
  repoGroupPrefs: RepoGroupPref[];
  usageSummaries: PersistedSessionUsage[];
  knownHosts: KnownHostEntry[];
}

export interface PersistedSessionUsage {
  claudeSessionId: string;
  workingDir: string;
  /**
   * Full path to the JSONL transcript. Set when the session was discovered
   * via directory scan (where `workingDir` is the encoded Claude project
   * dir name, which is lossy to decode). When absent, the path is derived
   * from `workingDir` via `transcriptPath()` — the older flow for sessions
   * launched by Tether itself.
   */
  filePath?: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalCost: number;
  models: Array<{
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    cost: number;
  }>;
  messageCount: number;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
  parsedByteOffset: number;
}

export interface EnvironmentRow {
  id: string;
  name: string;
  type: 'local' | 'ssh' | 'coder';
  config: string;
  env_vars: string; // JSON-encoded Record<string, string>
  auth_mode: string | null;
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
const CLI_TOOL_IDS: CliToolId[] = ['claude', 'codex', 'copilot', 'opencode', 'custom'];

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

function parseStringArrayJson(value: unknown): string[] {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function normalizeFlagsPerTool(
  value: unknown,
  legacyFlags: string[],
): Partial<Record<CliToolId, string[]>> {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const result: Partial<Record<CliToolId, string[]>> = {};
      const record = parsed as Record<string, unknown>;
      for (const toolId of CLI_TOOL_IDS) {
        const flags = record[toolId];
        if (Array.isArray(flags)) {
          result[toolId] = flags.filter((item): item is string => typeof item === 'string');
        }
      }
      if (Object.keys(result).length > 0) {
        return result;
      }
    }
  } catch {
    // Fall back to legacy Claude flags below.
  }

  return legacyFlags.length > 0 ? { claude: legacyFlags } : {};
}

function normalizeLaunchProfiles(profiles: unknown): LaunchProfileRow[] {
  if (!Array.isArray(profiles)) {
    return [];
  }
  return profiles.map((profile) => {
    const record = profile as Record<string, unknown>;
    const legacyFlags = parseStringArrayJson(record.cli_flags);
    const flagsPerTool = normalizeFlagsPerTool(record.cli_flags_per_tool, legacyFlags);
    return {
      ...record,
      env_vars: typeof record.env_vars === 'string' ? record.env_vars : '{}',
      cli_flags: JSON.stringify(legacyFlags),
      cli_flags_per_tool: JSON.stringify(flagsPerTool),
    } as LaunchProfileRow;
  });
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
        // Migrate flat defaultCliFlags -> per-tool storage (all old flags were Claude flags)
        let perTool: Partial<Record<CliToolId, string[]>> = loaded.defaultCliFlagsPerTool || {};
        let flatFlags: string[] = loaded.defaultCliFlags || [];
        if (!loaded.defaultCliFlagsPerTool && flatFlags.length > 0) {
          perTool = { claude: [...flatFlags] };
          flatFlags = [];
        }
        data = {
          environments: envs,
          sessions: loaded.sessions || [],
          launchProfiles: normalizeLaunchProfiles(loaded.launchProfiles),
          config: loaded.config || {},
          defaultEnvVars: loaded.defaultEnvVars || {},
          defaultCliFlags: flatFlags,
          defaultCliFlagsPerTool: perTool,
          savedWorkspace: loaded.savedWorkspace || null,
          gitProviders: loaded.gitProviders || [],
          repoGroupPrefs: loaded.repoGroupPrefs || [],
          usageSummaries: loaded.usageSummaries || [],
          knownHosts: loaded.knownHosts || [],
        };
      } catch {
        data = { environments: [], sessions: [], launchProfiles: [], config: {}, defaultEnvVars: {}, defaultCliFlags: [], defaultCliFlagsPerTool: {}, savedWorkspace: null, gitProviders: [], repoGroupPrefs: [], usageSummaries: [], knownHosts: [] };
      }
    } else {
      data = { environments: [], sessions: [], launchProfiles: [], config: {}, defaultEnvVars: {}, defaultCliFlags: [], defaultCliFlagsPerTool: {}, savedWorkspace: null, gitProviders: [], repoGroupPrefs: [], usageSummaries: [], knownHosts: [] };
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
