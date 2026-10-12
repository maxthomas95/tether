export type RemoteUsageCli = 'claude' | 'codex';

export interface RemoteUsageSource {
  /** Distinguishes local data and identical native ids on different hosts/users. */
  scope: string;
  nativeSessionId: string;
  path: string;
  identity: string;
}

export interface RemoteUsageCursor {
  offset: number;
  identity: string;
}

export interface RemoteUsageRequest {
  /** Correlates a reply with its request on the resident probe's shared stream. */
  id?: number;
  cli: RemoteUsageCli;
  marker: string;
  nativeSessionId?: string;
  workingDir: string;
  home?: string;
  claudeHome?: string;
  codexHome?: string;
  source?: RemoteUsageSource;
  cursor?: RemoteUsageCursor;
}

export interface RemoteUsageReply {
  id?: number;
  status: 'ready' | 'pending';
  source?: RemoteUsageSource;
  /** Sanitized JSONL: only model, timestamp, numeric usage and native thread identity. */
  text?: string;
  offset?: number;
  reset?: boolean;
  more?: boolean;
}

export function remoteUsageKey(environmentId: string, workspace: string, cli: RemoteUsageCli, source: RemoteUsageSource): string {
  // JSON encoding is unambiguous even when names contain delimiters.
  return `remote:${JSON.stringify([environmentId, workspace, cli, source.scope, source.nativeSessionId])}`;
}

/** Where a session's remote reader runs. Sessions sharing a target share one resident process. */
export interface RemoteProbeTarget {
  environmentId: string;
  /** Coder workspace; empty for SSH, where the environment already names the host. */
  workspace: string;
  workingDir: string;
  home?: string;
  claudeHome?: string;
}

/**
 * Subagent requests ride the same resident reader as usage. They carry `op`,
 * which usage requests never do, so the two cannot be confused.
 */
export interface RemoteSubagentRequest {
  id?: number;
  op: 'subagents' | 'subagent-transcript';
  cli: 'claude';
  /** Claude's own session id; names the folder that holds the subagents. */
  sessionId: string;
  workingDir: string;
  home?: string;
  claudeHome?: string;
  /** Project folder from the last reply, so the reader need not glob again. */
  project?: string;
  /** False skips the search across all project folders (after repeated misses); the direct and hinted folders are still tried. */
  scan?: boolean;
  /** `subagents`: what this side already holds per agent id. */
  known?: Record<string, { offset: number; metaMtimeMs: number; /** The task prompt is already held, so no more prompt text is needed. */ prompt?: boolean }>;
  /** `subagent-transcript`: which agent, and the byte offset to continue from. */
  agentId?: string;
  offset?: number;
}

export interface RemoteSubagentFile {
  id: string;
  size: number;
  mtimeMs: number;
  birthMs: number;
  /** Offset after the complete lines in `text`; where the next request continues. */
  offset: number;
  /** The file shrank below the requested offset, so `text` starts again at 0. */
  reset?: boolean;
  /**
   * Slimmed JSONL: one line per complete line appended since the requested
   * offset, keeping only the fields the summary parser reads. No message
   * content, tool inputs or tool results. `offset` still counts raw file bytes.
   */
  text: string;
  /** 0 when the meta file is missing. */
  metaMtimeMs: number;
  /** meta.json text; present only when it differs from what the caller holds. */
  meta?: string;
}

export interface RemoteSubagentListReply {
  id?: number;
  op: 'subagents';
  status: 'ready';
  found: boolean;
  project?: string;
  /** Newest first, at most `REMOTE_SUBAGENT_MAX_AGENTS`. */
  agents: RemoteSubagentFile[];
  /** Agent files in the folder, which can exceed `agents.length`. */
  total: number;
  /** Bytes were left unread this round (response cap); ask again soon. */
  more: boolean;
  /** The remote clock, so file ages are not skewed by a clock that differs from ours. */
  now: number;
}

export interface RemoteSubagentTranscriptReply {
  id?: number;
  op: 'subagent-transcript';
  status: 'ready';
  found: boolean;
  project?: string;
  /** Complete raw lines from the requested offset; the viewer's only source of full text. */
  text: string;
  offset: number;
  size: number;
  reset?: boolean;
  more: boolean;
}

export type RemoteSubagentReply = RemoteSubagentListReply | RemoteSubagentTranscriptReply;

export const REMOTE_SUBAGENT_MAX_AGENTS = 50;
/** Largest text payload (characters) accepted in one reply, however the remote was asked. */
export const REMOTE_SUBAGENT_MAX_REPLY_TEXT = 8 * 1024 * 1024;
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * The remote is trusted to read files, not to be well formed. Everything that
 * reaches the parsers is checked here: shapes, ranges and total size.
 */
export function validateSubagentReply(raw: unknown): RemoteSubagentReply {
  const bad = () => new Error('Invalid remote subagent reply');
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || r.status !== 'ready' || typeof r.found !== 'boolean') throw bad();
  const project = r.project === undefined ? undefined : r.project;
  if (project !== undefined && (typeof project !== 'string' || project.length > 512)) throw bad();
  const id = r.id === undefined ? undefined : r.id;
  if (id !== undefined && typeof id !== 'number') throw bad();

  if (r.op === 'subagent-transcript') {
    if (typeof r.text !== 'string' || r.text.length > REMOTE_SUBAGENT_MAX_REPLY_TEXT
      || !isCount(r.offset) || !isCount(r.size) || typeof r.more !== 'boolean') throw bad();
    return { id, op: 'subagent-transcript', status: 'ready', found: r.found, project, text: r.text,
      offset: r.offset, size: r.size, more: r.more, ...(r.reset === true ? { reset: true } : {}) };
  }
  if (r.op !== 'subagents' || !Array.isArray(r.agents) || r.agents.length > REMOTE_SUBAGENT_MAX_AGENTS
    || !isCount(r.total) || typeof r.more !== 'boolean' || !isTime(r.now)) throw bad();

  let payload = 0;
  const seen = new Set<string>();
  const agents = r.agents.map((entry: unknown): RemoteSubagentFile => {
    const a = entry as Record<string, unknown> | null;
    if (!a || typeof a !== 'object' || typeof a.id !== 'string' || !AGENT_ID_RE.test(a.id) || seen.has(a.id)
      || !isCount(a.size) || !isTime(a.mtimeMs) || !isTime(a.birthMs) || !isCount(a.offset) || a.offset > a.size
      || typeof a.text !== 'string' || !isTime(a.metaMtimeMs)
      || (a.meta !== undefined && typeof a.meta !== 'string')) throw bad();
    seen.add(a.id);
    payload += a.text.length + (typeof a.meta === 'string' ? a.meta.length : 0);
    if (payload > REMOTE_SUBAGENT_MAX_REPLY_TEXT) throw bad();
    return { id: a.id, size: a.size, mtimeMs: a.mtimeMs, birthMs: a.birthMs, offset: a.offset, text: a.text,
      metaMtimeMs: a.metaMtimeMs, ...(a.reset === true ? { reset: true } : {}),
      ...(typeof a.meta === 'string' ? { meta: a.meta } : {}) };
  });
  return { id, op: 'subagents', status: 'ready', found: r.found, project, agents, total: r.total, more: r.more, now: r.now };
}
