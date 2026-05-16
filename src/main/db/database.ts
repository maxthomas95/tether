import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { atomicWriteFileSync, cleanupOrphanTmp } from './atomic-write';
import { createLogger } from '../logger';
import type { CliToolId } from '../../shared/cli-tools';
import type { RepoGroupPref, SessionOrderPref } from '../../shared/types';
import type { KeybindingAction, Chord } from '../../shared/keybindings';

const log = createLogger('database');

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
  type: 'gitea' | 'ado' | 'github';
  baseUrl: string;
  organization: string | null;
  /** ADO only: pre-fills the project picker when creating a new repo. */
  defaultProject?: string | null;
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
  sessionOrderPrefs: SessionOrderPref[];
  usageSummaries: PersistedSessionUsage[];
  knownHosts: KnownHostEntry[];
  keybindings?: Partial<Record<KeybindingAction, Chord | null>>;
}

export interface PersistedSessionUsage {
  /** Session identifier — Claude UUID or Crush id. */
  sessionId: string;
  /** Which CLI tool produced this usage data. */
  cliTool: string;
  workingDir: string;
  /**
   * Tether environment id this session ran under, when known. Sessions
   * discovered via disk backfill (Claude's `~/.claude/projects/`, Codex's
   * `~/.codex/sessions/`) have no environment context, so this stays
   * undefined and the renderer surfaces them as "Unattributed".
   */
  environmentId?: string;
  /**
   * Full path to the JSONL transcript (Claude/Codex only). Set when the
   * session was discovered via directory scan (where `workingDir` is the
   * encoded Claude project dir name, which is lossy to decode). When absent,
   * the path is derived from `workingDir` via `transcriptPath()` — the older
   * flow for sessions launched by Tether itself.
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

function emptyDbData(): DbData {
  return {
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
    keybindings: {},
  };
}

function migrateLoadedDb(loaded: Record<string, unknown>): DbData {
  const envs = ((loaded.environments as Record<string, unknown>[]) || []).map((e) => ({
    ...e,
    env_vars: e.env_vars || '{}',
  })) as EnvironmentRow[];

  // Migrate flat defaultCliFlags -> per-tool storage (all old flags were Claude flags)
  let perTool: Partial<Record<CliToolId, string[]>> = (loaded.defaultCliFlagsPerTool as Partial<Record<CliToolId, string[]>>) || {};
  let flatFlags: string[] = (loaded.defaultCliFlags as string[]) || [];
  if (!loaded.defaultCliFlagsPerTool && flatFlags.length > 0) {
    perTool = { claude: [...flatFlags] };
    flatFlags = [];
  }

  const rawBindings = loaded.keybindings;
  const keybindings = rawBindings && typeof rawBindings === 'object' && !Array.isArray(rawBindings)
    ? (rawBindings as DbData['keybindings'])
    : {};

  return {
    environments: envs,
    sessions: (loaded.sessions as SessionRow[]) || [],
    launchProfiles: normalizeLaunchProfiles(loaded.launchProfiles),
    config: (loaded.config as Record<string, string>) || {},
    defaultEnvVars: (loaded.defaultEnvVars as Record<string, string>) || {},
    defaultCliFlags: flatFlags,
    defaultCliFlagsPerTool: perTool,
    savedWorkspace: (loaded.savedWorkspace as SavedWorkspace | null) || null,
    gitProviders: (loaded.gitProviders as GitProviderRow[]) || [],
    repoGroupPrefs: (loaded.repoGroupPrefs as RepoGroupPref[]) || [],
    sessionOrderPrefs: (loaded.sessionOrderPrefs as SessionOrderPref[]) || [],
    usageSummaries: (loaded.usageSummaries as PersistedSessionUsage[]) || [],
    knownHosts: (loaded.knownHosts as KnownHostEntry[]) || [],
    keybindings,
  };
}

export function getDb(): DbData {
  if (data) return data;

  const filePath = getDbPath();
  const orphanState = cleanupOrphanTmp(filePath);
  if (orphanState === 'orphan-only') {
    log.warn('Found orphan data.json.tmp with no data.json — leaving in place; starting from defaults');
  }
  if (!fs.existsSync(filePath)) {
    data = emptyDbData();
    return data;
  }
  try {
    const loaded = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    data = migrateLoadedDb(loaded);
  } catch {
    data = emptyDbData();
  }
  return data;
}

export function saveDb(): void {
  if (data) {
    atomicWriteFileSync(getDbPath(), JSON.stringify(data, null, 2));
  }
}

export function closeDb(): void {
  saveDb();
  data = null;
}
