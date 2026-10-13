import fs from 'node:fs';
import path from 'node:path';
import type {
  ChildAgentInfo,
  ChildAgentList,
  ChildAgentTokens,
  ChildAgentTranscript,
  ChildTranscriptEntry,
} from '../../shared/child-agents';
import { getClaudeProjectsRoot, getProjectDir } from './transcripts';
import { asRecord, oneLine, parseLine, str, validIso, type Json } from '../transcripts/json-lines';
import {
  HeadTailReader,
  MAX_VIEWER_ENTRIES,
  TRANSCRIPT_HEAD_BYTES,
  TRANSCRIPT_TAIL_BYTES,
  capDigestEntries,
  createDigestState,
  readCompleteLines,
  visibleDigestEntries,
  type DigestState,
  type ToolEntry,
} from '../transcripts/incremental-lines';

export { MAX_VIEWER_ENTRIES, TRANSCRIPT_HEAD_BYTES, TRANSCRIPT_TAIL_BYTES };

/**
 * Reader for the files Claude Code writes for each subagent:
 *   <claude-home>/projects/<encoded-cwd>/<sessionId>/subagents/agent-<id>.jsonl
 *   <claude-home>/projects/<encoded-cwd>/<sessionId>/subagents/agent-<id>.meta.json
 *
 * The format is internal and undocumented, so everything here tolerates a
 * missing meta file (older Claude Code), malformed lines and unknown fields.
 * The parse functions take text so a remote probe can feed them later; only
 * `SubagentDirReader` and the `find`/`read` helpers touch the filesystem.
 */

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const AGENT_FILE_RE = /^agent-([A-Za-z0-9_-]{1,64})\.jsonl$/;

/** Newest subagents kept per session; older files are ignored. */
export const MAX_TRACKED_SUBAGENTS = 50;
const MAX_SPAWN_TOOL_IDS = 200;
const SPAWN_TOOL_NAMES = new Set(['Agent', 'Task']);

export function isValidAgentId(id: unknown): id is string {
  return typeof id === 'string' && AGENT_ID_RE.test(id);
}

// ---------------------------------------------------------------------------
// Pure parsing
// ---------------------------------------------------------------------------

export interface SubagentMeta {
  agentType?: string;
  description?: string;
  toolUseId?: string;
  parentAgentId?: string;
  spawnDepth?: number;
  requestShape?: string;
  /** Requested, not necessarily what ran. */
  model?: string;
  effort?: string;
}

export function parseSubagentMeta(text: string): SubagentMeta | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const depth = typeof rec.spawnDepth === 'number' && Number.isFinite(rec.spawnDepth) && rec.spawnDepth >= 1
    ? Math.min(Math.floor(rec.spawnDepth), 16)
    : undefined;
  return {
    agentType: str(rec.agentType, 80),
    description: str(rec.description, 300),
    toolUseId: str(rec.toolUseId, 128),
    parentAgentId: isValidAgentId(rec.parentAgentId) ? rec.parentAgentId : undefined,
    spawnDepth: depth,
    requestShape: str(rec.requestShape, 40),
    model: str(rec.model, 100),
    effort: str(rec.effort, 40),
  };
}

function finiteCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function blocks(message: Json | null): Json[] {
  const content = message?.content;
  return Array.isArray(content) ? content.map(asRecord).filter((b): b is Json => b !== null) : [];
}

function textOf(message: Json | null): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  return blocks(message)
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text as string)
    .join('\n');
}

/** What an incremental read of one subagent transcript has learned so far. */
export interface SubagentScan {
  startedAt: string | null;
  lastActivityAt: string | null;
  /** Resolved model of the last assistant message. */
  model?: string;
  effort?: string;
  firstPrompt?: string;
  /** Usage per API response; one response is split across several lines. */
  usage: Map<string, ChildAgentTokens>;
  /** Ids of Agent/Task tool calls this child made, to resolve nesting. */
  spawnToolIds: Set<string>;
}

function cloneScan(scan: SubagentScan): SubagentScan {
  return { ...scan, usage: new Map(scan.usage), spawnToolIds: new Set(scan.spawnToolIds) };
}

export function createSubagentScan(): SubagentScan {
  return { startedAt: null, lastActivityAt: null, usage: new Map(), spawnToolIds: new Set() };
}

/** Fold complete JSONL lines (as text) into `scan`. Malformed lines are skipped. */
export function foldSubagentLines(scan: SubagentScan, text: string): void {
  for (const line of text.split('\n')) {
    const entry = parseLine(line);
    if (!entry) continue;
    const type = entry.type;
    if (type === 'fork-context-ref') continue;

    const at = validIso(entry.timestamp);
    if (at) {
      if (!scan.startedAt || Date.parse(at) < Date.parse(scan.startedAt)) scan.startedAt = at;
      if (!scan.lastActivityAt || Date.parse(at) >= Date.parse(scan.lastActivityAt)) scan.lastActivityAt = at;
    }

    const message = asRecord(entry.message);
    if (type === 'user') {
      if (!scan.firstPrompt && blocks(message).every(b => b.type !== 'tool_result')) {
        const prompt = textOf(message).trim();
        if (prompt) scan.firstPrompt = prompt.slice(0, 400);
      }
      continue;
    }
    if (type !== 'assistant' || !message) continue;

    const model = str(message.model, 100);
    // "<synthetic>" marks Claude Code's own error messages, not a model.
    if (model && !model.startsWith('<')) scan.model = model;
    const effort = str(entry.effort, 40);
    if (effort) scan.effort = effort;

    for (const block of blocks(message)) {
      if (block.type === 'tool_use' && typeof block.name === 'string' && SPAWN_TOOL_NAMES.has(block.name)
        && typeof block.id === 'string' && scan.spawnToolIds.size < MAX_SPAWN_TOOL_IDS) {
        scan.spawnToolIds.add(block.id);
      }
    }

    const usage = asRecord(message.usage);
    if (usage) {
      const key = str(message.id, 128) ?? str(entry.requestId, 128) ?? str(entry.uuid, 128);
      if (key) {
        const next: ChildAgentTokens = {
          input: finiteCount(usage.input_tokens),
          output: finiteCount(usage.output_tokens),
          cacheRead: finiteCount(usage.cache_read_input_tokens),
          cacheWrite: finiteCount(usage.cache_creation_input_tokens),
        };
        const seen = scan.usage.get(key);
        // Later blocks of the same response repeat the usage; keep the largest
        // so a partial figure on an early block never wins.
        scan.usage.set(key, seen ? {
          input: Math.max(seen.input, next.input),
          output: Math.max(seen.output, next.output),
          cacheRead: Math.max(seen.cacheRead, next.cacheRead),
          cacheWrite: Math.max(seen.cacheWrite, next.cacheWrite),
        } : next);
      }
    }
  }
}

export function scanTokens(scan: SubagentScan): ChildAgentTokens {
  const total: ChildAgentTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const u of scan.usage.values()) {
    total.input += u.input;
    total.output += u.output;
    total.cacheRead += u.cacheRead;
    total.cacheWrite += u.cacheWrite;
  }
  return total;
}

export interface SubagentSnapshot {
  id: string;
  meta: SubagentMeta | null;
  scan: SubagentScan;
  mtimeMs: number;
  birthMs: number;
}

function firstLine(text: string, max: number): string {
  const line = text.split('\n').find(l => l.trim()) ?? '';
  const trimmed = line.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

export function toChildAgentInfo(snapshot: SubagentSnapshot, running: boolean): ChildAgentInfo {
  const { id, meta, scan } = snapshot;
  const started = scan.startedAt ?? new Date(snapshot.birthMs || snapshot.mtimeMs).toISOString();
  const lastActivity = scan.lastActivityAt ?? new Date(snapshot.mtimeMs).toISOString();
  return {
    source: 'claude-subagent',
    id,
    agentType: meta?.agentType ?? 'subagent',
    description: meta?.description ?? (scan.firstPrompt ? firstLine(scan.firstPrompt, 80) : ''),
    ...(meta?.model ? { requestedModel: meta.model } : {}),
    ...(scan.model ? { model: scan.model } : {}),
    ...((scan.effort ?? meta?.effort) ? { effort: scan.effort ?? meta?.effort } : {}),
    background: meta?.requestShape === 'background',
    depth: meta?.spawnDepth ?? 1,
    ...(meta?.toolUseId ? { parentToolUseId: meta.toolUseId } : {}),
    state: running ? 'running' : 'done',
    startedAt: started,
    lastActivityAt: lastActivity,
    tokens: scanTokens(scan),
  };
}

/**
 * Build the display list: each child follows the child that spawned it,
 * otherwise oldest first. The spawner comes from `parentAgentId` in the meta
 * file when present, else from the Agent/Task call whose id is `toolUseId`.
 */
export function buildChildAgentList(
  snapshots: SubagentSnapshot[],
  isRunning: (id: string, mtimeMs: number) => boolean,
  total = snapshots.length,
): ChildAgentList {
  const byId = new Map(snapshots.map(s => [s.id, s]));
  const spawnedBy = new Map<string, string>();
  for (const s of snapshots) {
    for (const toolId of s.scan.spawnToolIds) spawnedBy.set(toolId, s.id);
  }

  const infos = new Map<string, ChildAgentInfo>();
  for (const s of snapshots) {
    const info = toChildAgentInfo(s, isRunning(s.id, s.mtimeMs));
    let parent = s.meta?.parentAgentId;
    if (!parent || !byId.has(parent)) parent = s.meta?.toolUseId ? spawnedBy.get(s.meta.toolUseId) : undefined;
    if (parent && parent !== s.id && byId.has(parent)) info.parentId = parent;
    infos.set(s.id, info);
  }

  const byStart = (a: ChildAgentInfo, b: ChildAgentInfo) =>
    Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.id.localeCompare(b.id);
  const children = new Map<string, ChildAgentInfo[]>();
  const roots: ChildAgentInfo[] = [];
  for (const info of infos.values()) {
    if (info.parentId) {
      const list = children.get(info.parentId) ?? [];
      list.push(info);
      children.set(info.parentId, list);
    } else {
      roots.push(info);
    }
  }

  const ordered: ChildAgentInfo[] = [];
  const placed = new Set<string>();
  const place = (info: ChildAgentInfo) => {
    if (placed.has(info.id)) return;
    placed.add(info.id);
    ordered.push(info);
    for (const child of (children.get(info.id) ?? []).sort(byStart)) place(child);
  };
  for (const root of roots.sort(byStart)) place(root);
  // A spawn cycle in corrupt data leaves no root; list what is left anyway.
  for (const info of [...infos.values()].sort(byStart)) place(info);
  return { agents: ordered, total };
}

// ---------------------------------------------------------------------------
// Viewer digest
// ---------------------------------------------------------------------------

const SUMMARY_KEYS = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'skill', 'prompt'];

export function summarizeToolInput(input: unknown): string {
  if (typeof input === 'string') return oneLine(input, 160);
  const rec = asRecord(input);
  if (!rec) return '';
  for (const key of SUMMARY_KEYS) {
    const value = rec[key];
    if (typeof value === 'string' && value.trim()) return oneLine(value, 160);
  }
  const first = Object.values(rec).find(v => typeof v === 'string' && v.trim());
  return typeof first === 'string' ? oneLine(first, 160) : '';
}

export interface ParsedSubagentTranscript {
  prompt: string | null;
  entries: ChildTranscriptEntry[];
  result: string | null;
  /** Earlier activity is missing: skipped bytes of a long file or entries past the cap. */
  truncated: boolean;
}

/** Accumulates a transcript digest line by line, so a file can be read in pieces. */
export type TranscriptState = DigestState;

export const createTranscriptState = createDigestState;

/** Fold complete JSONL lines (as text) into `state`. Keeps only the newest entries. */
export function foldTranscriptLines(state: TranscriptState, text: string): void {
  for (const line of text.split('\n')) {
    const entry = parseLine(line);
    if (!entry) continue;
    const message = asRecord(entry.message);
    if (entry.type === 'user' && message) {
      const content = blocks(message);
      if (state.prompt === null && content.every(b => b.type !== 'tool_result')) {
        const body = textOf(message).trim();
        if (body) state.prompt = body.slice(0, 8000);
      }
      for (const block of content) {
        if (block.type === 'tool_result' && block.is_error === true && typeof block.tool_use_id === 'string') {
          const tool = state.toolEntries.get(block.tool_use_id);
          if (tool) tool.failed = true;
        }
      }
      continue;
    }
    if (entry.type !== 'assistant' || !message) continue;
    for (const block of blocks(message)) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        state.entries.push({ kind: 'text', text: block.text.trim().slice(0, 4000) });
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        const tool: ToolEntry = { kind: 'tool', name: block.name.slice(0, 80), summary: summarizeToolInput(block.input) };
        state.entries.push(tool);
        if (typeof block.id === 'string') state.toolEntries.set(block.id, tool);
      }
    }
    capDigestEntries(state);
  }
}

/** Snapshot of `state` for the viewer; does not change it, so reading can continue. */
export function finishTranscript(state: TranscriptState): ParsedSubagentTranscript {
  const { entries, truncated } = visibleDigestEntries(state);
  // The closing text is the answer; showing it twice would only add noise.
  let result: string | null = null;
  const last = entries.at(-1);
  if (last?.kind === 'text') {
    result = last.text;
    entries.pop();
  }
  return { prompt: state.prompt, entries, result, truncated };
}

/**
 * Reduce a subagent transcript to the task, a compact list of assistant text
 * and tool calls, and the final answer. Tool output is not kept.
 */
export function parseSubagentTranscript(text: string, truncated = false): ParsedSubagentTranscript {
  const state = createTranscriptState();
  state.skippedMiddle = truncated;
  foldTranscriptLines(state, text);
  return finishTranscript(state);
}

export function buildChildAgentTranscript(agent: ChildAgentInfo, parsed: ParsedSubagentTranscript): ChildAgentTranscript {
  return { agent, ...parsed };
}

// ---------------------------------------------------------------------------
// Filesystem layer
// ---------------------------------------------------------------------------

const isDir = (p: string) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/** One stat: the folder Claude names from the working directory. */
export function findSubagentsDirDirect(sessionId: string, cwd: string): string | null {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  try {
    const direct = path.join(getProjectDir(cwd), sessionId, 'subagents');
    return isDir(direct) ? direct : null;
  } catch { return null; }
}

/**
 * Scan every project folder for the one that holds this session. Claude
 * hash-suffixes long folder names and we cannot recompute that, so this is the
 * fallback; it costs a readdir plus a stat per project, so callers back off.
 */
export function findSubagentsDirByScan(sessionId: string): string | null {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  const root = getClaudeProjectsRoot();
  let names: string[];
  try { names = fs.readdirSync(root); } catch { return null; }
  const found = names.map(n => path.join(root, n, sessionId, 'subagents')).filter(isDir);
  return found.length === 1 ? found[0] : null;
}

/** Locate `<sessionId>/subagents`: the working-directory folder wins, else the scan. */
export function findSubagentsDir(sessionId: string, cwd?: string): string | null {
  return (cwd ? findSubagentsDirDirect(sessionId, cwd) : null) ?? findSubagentsDirByScan(sessionId);
}

interface FileState {
  size: number;
  offset: number;
  mtimeMs: number;
  birthMs: number;
  scan: SubagentScan;
  meta: SubagentMeta | null;
  metaMtimeMs: number;
}

async function readMeta(file: string, state: FileState): Promise<void> {
  try {
    const st = await fs.promises.stat(file);
    if (state.meta && st.mtimeMs === state.metaMtimeMs) return;
    state.meta = parseSubagentMeta(await fs.promises.readFile(file, 'utf8'));
    state.metaMtimeMs = st.mtimeMs;
  } catch {
    state.meta = null;
    state.metaMtimeMs = 0;
  }
}

/**
 * Tracks one session's subagents folder. Each refresh stats the files and
 * reads only the bytes appended since the last one.
 */
export class SubagentDirReader {
  private readonly files = new Map<string, FileState>();

  constructor(readonly dir: string) {}

  async refresh(): Promise<{ snapshots: SubagentSnapshot[]; total: number }> {
    let names: string[];
    try { names = await fs.promises.readdir(this.dir); } catch { this.files.clear(); return { snapshots: [], total: 0 }; }

    const present: Array<{ id: string; mtimeMs: number; birthMs: number; size: number }> = [];
    await Promise.all(names.map(async name => {
      const match = AGENT_FILE_RE.exec(name);
      if (!match) return;
      try {
        const st = await fs.promises.stat(path.join(this.dir, name));
        if (st.isFile()) present.push({ id: match[1], mtimeMs: st.mtimeMs, birthMs: st.birthtimeMs, size: st.size });
      } catch { /* removed between readdir and stat */ }
    }));
    present.sort((a, b) => b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id));
    const kept = present.slice(0, MAX_TRACKED_SUBAGENTS);
    const keptIds = new Set(kept.map(p => p.id));
    for (const id of this.files.keys()) if (!keptIds.has(id)) this.files.delete(id);

    const snapshots: SubagentSnapshot[] = [];
    for (const file of kept) {
      let state = this.files.get(file.id);
      if (!state || file.size < state.offset) {
        state = { size: 0, offset: 0, mtimeMs: 0, birthMs: file.birthMs, scan: createSubagentScan(), meta: null, metaMtimeMs: 0 };
        this.files.set(file.id, state);
      }
      if (file.size !== state.size || state.offset < file.size) {
        // Fold into a copy and commit with the offset, so a read that fails
        // part-way is retried from the same place instead of folded twice.
        try {
          const scan = cloneScan(state.scan);
          const end = await readCompleteLines(path.join(this.dir, `agent-${file.id}.jsonl`), state.offset, file.size,
            text => foldSubagentLines(scan, text));
          state.scan = scan;
          state.offset = end;
          state.size = file.size;
        } catch { /* leave size stale so the next refresh retries */ }
      }
      state.mtimeMs = file.mtimeMs;
      await readMeta(path.join(this.dir, `agent-${file.id}.meta.json`), state);
      snapshots.push({ id: file.id, meta: state.meta, scan: state.scan, mtimeMs: file.mtimeMs, birthMs: state.birthMs });
    }
    return { snapshots, total: present.length };
  }
}

/** Path of one subagent's transcript, or null for an id that could leave the folder. */
export function subagentTranscriptPath(dir: string, agentId: string): string | null {
  if (!isValidAgentId(agentId)) return null;
  const file = path.join(dir, `agent-${agentId}.jsonl`);
  return path.dirname(file) === dir ? file : null;
}

/**
 * Incremental reader behind the viewer: a long transcript is read as its head
 * plus its tail, then only appended bytes (see `HeadTailReader`).
 */
export class SubagentTranscriptReader extends HeadTailReader<TranscriptState, ParsedSubagentTranscript> {
  constructor() {
    super({ create: createTranscriptState, fold: foldTranscriptLines, finish: finishTranscript });
  }
}
