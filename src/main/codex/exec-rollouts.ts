import fs from 'node:fs';
import path from 'node:path';
import type {
  ChildAgentInfo,
  ChildAgentTokens,
  ChildAgentTranscript,
  ChildTranscriptEntry,
} from '../../shared/child-agents';
import {
  parseCodexUsageText,
  type CodexRequestUsageCheckpoint,
  type CodexTokenUsageCounters,
} from '../usage/codex-jsonl-parser';
import { asRecord, oneLine, parseLine, str, validIso, type Json } from '../transcripts/json-lines';
import {
  HeadTailReader,
  capDigestEntries,
  createDigestState,
  readCompleteLines,
  visibleDigestEntries,
  type DigestState,
  type ToolEntry,
} from '../transcripts/incremental-lines';

/**
 * Reader for the rollout file Codex writes for each run:
 *   <codex-home>/sessions/YYYY/MM/DD/rollout-<local timestamp>-<thread id>.jsonl
 * The first line is `session_meta` (id, cwd, originator, no model); each user
 * turn adds a `turn_context` line carrying `model` and `effort`. `codex exec
 * --ephemeral` writes no file at all.
 *
 * The format is internal and undocumented, so everything here tolerates
 * malformed lines and unknown fields. The parse functions take text so a
 * remote probe can feed them later; only the reader class and the `find`/`read`
 * helpers touch the filesystem. Token accounting is the existing Codex usage
 * parser's, not a second implementation.
 */

export const CODEX_EXEC_AGENT_TYPE = 'codex exec';

const THREAD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{7,127}$/;
const ROLLOUT_FILE_RE = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([A-Za-z0-9][A-Za-z0-9-]{7,127})\.jsonl$/;
const LINE_TIMESTAMP_RE = /^\{"timestamp":"([^"]+)"/;
/** `session_meta` carries the full base instructions, so the first line can be large. */
const HEAD_BYTES_SMALL = 64 * 1024;
const HEAD_BYTES = 256 * 1024;
const MAX_DAY_DIRS = 8;
const DAY_MS = 86_400_000;

/** Without hook events, a run counts as running while its rollout moved this recently. */
export const ROLLOUT_RUNNING_WINDOW_MS = 120_000;
/** With hooks, a run that said "running" and then went silent this long is treated as dead. */
export const HOOK_STALE_MS = 15 * 60_000;

export function isValidThreadId(id: unknown): id is string {
  return typeof id === 'string' && THREAD_ID_RE.test(id);
}

function firstLine(text: string, max: number): string {
  const line = text.split('\n').find(l => l.trim()) ?? '';
  return oneLine(line, max);
}

// ---------------------------------------------------------------------------
// Pure parsing
// ---------------------------------------------------------------------------

export interface CodexRolloutMeta {
  /** The thread id; a rollout is only trusted for the thread whose id it carries. */
  id: string;
  /** ISO start of the run, from `session_meta.timestamp` (UTC). */
  startedAt: string | null;
}

/** Read the first `session_meta` line out of the head of a rollout. */
export function parseCodexRolloutMeta(text: string): CodexRolloutMeta | null {
  for (const line of text.split('\n')) {
    if (!line.includes('"session_meta"')) continue;
    const entry = parseLine(line);
    if (entry?.type !== 'session_meta') continue;
    const payload = asRecord(entry.payload);
    const id = str(payload?.id, 256);
    if (!id) continue;
    return {
      id,
      startedAt: validIso(payload?.timestamp) ?? validIso(entry.timestamp),
    };
  }
  return null;
}

/** Context Codex injects as user-role messages; not what the user asked. */
function isInjectedContext(text: string): boolean {
  const head = text.trimStart();
  return head.startsWith('<') || head.startsWith('# AGENTS.md');
}

function messageText(payload: Record<string, unknown>, blockType: string): string {
  const content = payload.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(asRecord)
    .filter((b): b is Json => b !== null && b.type === blockType && typeof b.text === 'string')
    .map(b => b.text as string)
    .join('\n');
}

/**
 * The prompt of the run: the `user_message` event when present, otherwise the
 * first user-role response item that is not injected context.
 */
function promptOf(entry: Record<string, unknown>): string | null {
  const payload = asRecord(entry.payload);
  if (!payload) return null;
  if (entry.type === 'event_msg' && payload.type === 'user_message' && typeof payload.message === 'string') {
    return payload.message.trim() || null;
  }
  if (entry.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
    const text = messageText(payload, 'input_text').trim();
    return text && !isInjectedContext(text) ? text : null;
  }
  return null;
}

/** Codex serialises its completion event as `task_complete` with the alias `turn_complete`. */
const COMPLETION_EVENTS = new Set(['task_complete', 'turn_complete', 'turn_aborted', 'shutdown_complete']);
const START_EVENTS = new Set(['task_started', 'turn_started']);

/** What an incremental read of one rollout has learned so far. */
export interface CodexExecScan {
  meta: CodexRolloutMeta | null;
  startedAt: string | null;
  lastActivityAt: string | null;
  firstPrompt?: string;
  /** The last turn event seen was a completion, so no turn is in progress. */
  completed: boolean;
  model?: string;
  effort?: string;
  tokens: ChildAgentTokens;
  /** Carried between folds for the shared Codex usage parser. */
  tokenUsage: CodexTokenUsageCounters | null;
  requestUsage: CodexRequestUsageCheckpoint | null;
  contextWindowTokens: number | null;
  contextUsedTokens: number | null;
}

export function createCodexExecScan(): CodexExecScan {
  return {
    meta: null, startedAt: null, lastActivityAt: null, completed: false,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    tokenUsage: null, requestUsage: null, contextWindowTokens: null, contextUsedTokens: null,
  };
}

/** Fold complete JSONL lines (as text) into `scan`. Malformed lines are skipped. */
export function foldCodexExecText(scan: CodexExecScan, text: string): void {
  if (!text) return;
  const complete = text.endsWith('\n') ? text : `${text}\n`;

  for (const line of complete.split('\n')) {
    if (!line.startsWith('{')) continue;
    const stamp = LINE_TIMESTAMP_RE.exec(line)?.[1];
    if (stamp && validIso(stamp)) {
      if (!scan.startedAt || Date.parse(stamp) < Date.parse(scan.startedAt)) scan.startedAt = stamp;
      if (!scan.lastActivityAt || Date.parse(stamp) >= Date.parse(scan.lastActivityAt)) scan.lastActivityAt = stamp;
    }
    const wantsMeta = !scan.meta && line.includes('"session_meta"');
    const wantsPrompt = !scan.firstPrompt && (line.includes('"user_message"') || line.includes('"role":"user"'));
    const wantsTurn = line.includes('"task_started"') || line.includes('"turn_started"')
      || line.includes('"task_complete"') || line.includes('"turn_complete"')
      || line.includes('"turn_aborted"') || line.includes('"shutdown_complete"');
    if (!wantsMeta && !wantsPrompt && !wantsTurn) continue;
    const entry = parseLine(line);
    if (!entry) continue;
    if (wantsMeta && entry.type === 'session_meta') {
      const meta = parseCodexRolloutMeta(line);
      if (meta) {
        scan.meta = meta;
        if (meta.startedAt && (!scan.startedAt || Date.parse(meta.startedAt) < Date.parse(scan.startedAt))) {
          scan.startedAt = meta.startedAt;
        }
      }
      continue;
    }
    if (wantsPrompt) {
      const prompt = promptOf(entry);
      if (prompt) scan.firstPrompt = prompt.slice(0, 400);
    }
    if (entry.type === 'event_msg') {
      const kind = asRecord(entry.payload)?.type;
      if (typeof kind === 'string' && START_EVENTS.has(kind)) scan.completed = false;
      else if (typeof kind === 'string' && COMPLETION_EVENTS.has(kind)) scan.completed = true;
    }
  }

  const usage = parseCodexUsageText(complete, {
    startOffset: 0,
    priorModel: scan.model ?? null,
    priorReasoningEffort: scan.effort ?? null,
    priorContextWindowTokens: scan.contextWindowTokens,
    priorContextUsedTokens: scan.contextUsedTokens,
    priorTokenUsage: scan.tokenUsage,
    priorRequestUsage: scan.requestUsage,
    nativeSessionId: scan.meta?.id ?? null,
  });
  for (const message of usage.messages) {
    scan.tokens.input += message.inputTokens;
    scan.tokens.output += message.outputTokens;
    scan.tokens.cacheRead += message.cacheReadTokens;
    scan.tokens.cacheWrite += message.cacheCreation5m + message.cacheCreation1h;
  }
  if (usage.currentModel) scan.model = usage.currentModel;
  if (usage.currentReasoningEffort) scan.effort = usage.currentReasoningEffort;
  scan.tokenUsage = usage.tokenUsage;
  scan.requestUsage = usage.requestUsage;
  scan.contextWindowTokens = usage.contextWindowTokens;
  scan.contextUsedTokens = usage.contextUsedTokens;
}

/** What the hooks alone told us about a run. */
export interface CodexExecHookInfo {
  state: 'running' | 'done';
  firstAtMs: number;
  lastAtMs: number;
  model?: string;
}

export interface CodexExecInfoInput {
  threadId: string;
  scan: CodexExecScan | null;
  rolloutMtimeMs: number | null;
  hook: CodexExecHookInfo | null;
  nowMs: number;
  /** The Claude session is still alive; a dead one has no running children. */
  alive: boolean;
}

export function toCodexExecChildInfo(input: CodexExecInfoInput): ChildAgentInfo {
  const { scan, hook, rolloutMtimeMs, nowMs } = input;
  const mtime = rolloutMtimeMs ?? 0;
  let running: boolean;
  if (!input.alive) {
    running = false;
  } else if (hook) {
    const lastSignal = Math.max(hook.lastAtMs, mtime);
    const finishedInRollout = !!scan?.completed && mtime >= hook.lastAtMs;
    running = hook.state === 'running' && !finishedInRollout && nowMs - lastSignal <= HOOK_STALE_MS;
  } else {
    running = !!scan && !scan.completed && nowMs - mtime <= ROLLOUT_RUNNING_WINDOW_MS;
  }

  const startedMs = [scan?.startedAt ? Date.parse(scan.startedAt) : NaN, hook?.firstAtMs ?? NaN]
    .filter(Number.isFinite)
    .reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);
  const started = Number.isFinite(startedMs) ? startedMs : (mtime || nowMs);
  const lastMs = [scan?.lastActivityAt ? Date.parse(scan.lastActivityAt) : NaN, hook?.lastAtMs ?? NaN, mtime || NaN]
    .filter(Number.isFinite)
    .reduce((a, b) => Math.max(a, b), started);
  const model = scan?.model ?? hook?.model;
  return {
    source: 'codex-exec',
    id: input.threadId,
    agentType: CODEX_EXEC_AGENT_TYPE,
    description: scan?.firstPrompt ? firstLine(scan.firstPrompt, 80) : '',
    ...(model ? { model } : {}),
    ...(scan?.effort ? { effort: scan.effort } : {}),
    background: false,
    depth: 1,
    state: running ? 'running' : 'done',
    startedAt: new Date(started).toISOString(),
    lastActivityAt: new Date(lastMs).toISOString(),
    tokens: scan ? { ...scan.tokens } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

// ---------------------------------------------------------------------------
// Viewer digest
// ---------------------------------------------------------------------------

function commandFromArgv(argv: unknown[]): string {
  const parts = argv.filter((p): p is string => typeof p === 'string');
  // `bash -lc "<script>"` and friends: the script is the command.
  if (parts.length >= 3 && /^-[a-z]*c$/i.test(parts[1])) return parts[2];
  if (parts.length >= 3 && /^-command$/i.test(parts[1])) return parts[2];
  return parts.join(' ');
}

const PATCH_FILE_RE = /^\*\*\* (Add|Update|Delete) File: (.+)$/m;

/** `apply_patch` input is a patch, not JSON; name the first file it touches. */
function summarizePatch(input: string): string {
  const m = PATCH_FILE_RE.exec(input);
  return m ? `${m[1].toLowerCase()} ${m[2].trim()}` : oneLine(input, 160);
}

const ARGUMENT_KEYS = ['path', 'file_path', 'pattern', 'query', 'url', 'input', 'patch'];

/** One line describing a tool call's arguments (a JSON string, an object or free text). */
export function summarizeCodexArguments(args: unknown): string {
  let value = args;
  if (typeof args === 'string') {
    try { value = JSON.parse(args); } catch { return oneLine(args, 160); }
  }
  if (typeof value === 'string') return oneLine(value, 160);
  const rec = asRecord(value);
  if (!rec) return '';
  const command = rec.command ?? rec.cmd;
  if (Array.isArray(command)) return oneLine(commandFromArgv(command), 160);
  if (typeof command === 'string' && command.trim()) return oneLine(command, 160);
  for (const key of ARGUMENT_KEYS) {
    const candidate = rec[key];
    if (typeof candidate === 'string' && candidate.trim()) return oneLine(candidate, 160);
  }
  const first = Object.values(rec).find(v => typeof v === 'string' && v.trim());
  return typeof first === 'string' ? oneLine(first, 160) : '';
}

/** Best effort: a tool result that reports a non-zero exit or `success: false`. */
function outputFailed(output: unknown): boolean {
  if (typeof output === 'string') {
    try {
      const parsed = asRecord(JSON.parse(output));
      const code = asRecord(parsed?.metadata)?.exit_code;
      if (typeof code === 'number') return code !== 0;
    } catch { /* plain text output */ }
    const match = /^Exit code:\s*(-?\d+)/m.exec(output.slice(0, 400));
    return !!match && Number(match[1]) !== 0;
  }
  const rec = asRecord(output);
  return rec?.success === false;
}

export interface ParsedCodexExecTranscript {
  prompt: string | null;
  entries: ChildTranscriptEntry[];
  result: string | null;
  /** Earlier activity is missing: skipped bytes of a long file or entries past the cap. */
  truncated: boolean;
}

/** The shared digest state plus the run's completion message. */
export interface CodexTranscriptState extends DigestState {
  finalMessage: string | null;
}

export function createCodexTranscriptState(): CodexTranscriptState {
  return { ...createDigestState(), finalMessage: null };
}

/**
 * Fold complete JSONL lines (as text) into `state`. Keeps only the newest
 * entries. The `response_item` records are the canonical item list; the
 * matching `event_msg` records repeat them, so only the prompt and the
 * completion message come from events.
 */
export function foldCodexTranscriptLines(state: CodexTranscriptState, text: string): void {
  const addTool = (callId: unknown, name: string, summary: string) => {
    const tool: ToolEntry = { kind: 'tool', name: name.slice(0, 80), summary };
    state.entries.push(tool);
    if (typeof callId === 'string') state.toolEntries.set(callId, tool);
  };

  for (const line of text.split('\n')) {
    const entry = parseLine(line);
    if (!entry) continue;
    const payload = asRecord(entry.payload);
    if (!payload) continue;

    if (state.prompt === null) state.prompt = promptOf(entry)?.slice(0, 8000) ?? null;

    if (entry.type === 'event_msg') {
      if (payload.type === 'task_complete' || payload.type === 'turn_complete') {
        const last = typeof payload.last_agent_message === 'string' ? payload.last_agent_message.trim() : '';
        state.finalMessage = last ? last.slice(0, 8000) : null;
      }
      continue;
    }
    if (entry.type !== 'response_item') continue;

    switch (payload.type) {
      case 'message': {
        if (payload.role !== 'assistant') break;
        const body = messageText(payload, 'output_text').trim();
        if (body) state.entries.push({ kind: 'text', text: body.slice(0, 4000) });
        break;
      }
      case 'function_call':
        if (typeof payload.name === 'string') addTool(payload.call_id, payload.name, summarizeCodexArguments(payload.arguments));
        break;
      case 'custom_tool_call':
        if (typeof payload.name === 'string') {
          const input = payload.input;
          addTool(payload.call_id, payload.name, typeof input === 'string' && payload.name === 'apply_patch'
            ? summarizePatch(input)
            : summarizeCodexArguments(input));
        }
        break;
      case 'local_shell_call': {
        const command = asRecord(payload.action)?.command;
        addTool(payload.call_id, 'shell', Array.isArray(command) ? oneLine(commandFromArgv(command), 160) : '');
        break;
      }
      case 'web_search_call': {
        const query = asRecord(payload.action)?.query;
        addTool(undefined, 'web_search', typeof query === 'string' ? oneLine(query, 160) : '');
        break;
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const tool = typeof payload.call_id === 'string' ? state.toolEntries.get(payload.call_id) : undefined;
        if (tool && outputFailed(payload.output)) tool.failed = true;
        break;
      }
      default:
        break;
    }
    capDigestEntries(state);
  }
}

/** Snapshot of `state` for the viewer; does not change it, so reading can continue. */
export function finishCodexTranscript(state: CodexTranscriptState): ParsedCodexExecTranscript {
  const { entries, truncated } = visibleDigestEntries(state);
  // The closing message is the answer; showing it twice would only add noise.
  let result = state.finalMessage;
  const last = entries.at(-1);
  if (last?.kind === 'text') {
    if (result === null) result = last.text;
    if (last.text === result.slice(0, 4000)) entries.pop();
  }
  return { prompt: state.prompt, entries, result, truncated };
}

/**
 * Reduce a rollout to the task, a compact list of agent messages and tool
 * calls, and the final message. Tool output is not kept.
 */
export function parseCodexExecTranscript(text: string, truncated = false): ParsedCodexExecTranscript {
  const state = createCodexTranscriptState();
  state.skippedMiddle = truncated;
  foldCodexTranscriptLines(state, text);
  return finishCodexTranscript(state);
}

export function buildCodexExecTranscript(agent: ChildAgentInfo, parsed: ParsedCodexExecTranscript, note?: string): ChildAgentTranscript {
  return { agent, ...parsed, ...(note ? { note } : {}) };
}

// ---------------------------------------------------------------------------
// Rollout file names and locations
// ---------------------------------------------------------------------------

/** The thread id in a rollout file name, or null for any other file. */
export function rolloutThreadId(name: string): string | null {
  return ROLLOUT_FILE_RE.exec(name)?.[1] ?? null;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/**
 * `sessions/YYYY/MM/DD` folders (local dates, newest first) covering
 * `fromMs..toMs`, plus one day past `toMs` for clock or timezone skew. A run
 * that spans midnight keeps its file in the folder of the day it started, so
 * a window reaching back to the start finds it.
 */
export function rolloutDayDirs(codexHome: string, fromMs: number, toMs: number): string[] {
  const dirs: string[] = [];
  const day = new Date(toMs);
  day.setHours(12, 0, 0, 0);
  day.setDate(day.getDate() + 1);
  const floor = new Date(fromMs);
  floor.setHours(0, 0, 0, 0);
  for (let i = 0; i < MAX_DAY_DIRS && day.getTime() >= floor.getTime(); i++) {
    dirs.push(path.join(codexHome, 'sessions', pad(day.getFullYear(), 4), pad(day.getMonth() + 1), pad(day.getDate())));
    day.setDate(day.getDate() - 1);
  }
  return dirs;
}

/**
 * Find the rollout for a thread: the file whose name carries exactly this
 * thread id, in the date folders from a day before `sinceMs` (when its hooks
 * first reported) to a day past `nowMs`. The name's date is local time and can
 * be a day off the UTC start, hence the margin. A file whose own
 * `session_meta.id` is not this thread is rejected.
 */
export async function findRolloutByThreadId(
  threadId: string,
  codexHome: string,
  sinceMs: number,
  nowMs: number,
): Promise<string | null> {
  if (!isValidThreadId(threadId)) return null;
  for (const dir of rolloutDayDirs(codexHome, sinceMs - DAY_MS, nowMs)) {
    let names: string[];
    try { names = await fs.promises.readdir(dir); } catch { continue; }
    const hit = names.find(n => rolloutThreadId(n) === threadId);
    if (!hit) continue;
    const file = path.join(dir, hit);
    if ((await readRolloutHead(file))?.id === threadId) return file;
  }
  return null;
}

export async function readRolloutHead(file: string): Promise<CodexRolloutMeta | null> {
  let handle: fs.promises.FileHandle;
  try { handle = await fs.promises.open(file, 'r'); } catch { return null; }
  try {
    // Most headers fit the small read; the large one is for a long instruction block.
    for (const size of [HEAD_BYTES_SMALL, HEAD_BYTES]) {
      const buf = Buffer.allocUnsafe(size);
      const { bytesRead } = await handle.read(buf, 0, size, 0);
      const end = buf.subarray(0, bytesRead).indexOf(0x0a);
      if (end !== -1) return parseCodexRolloutMeta(buf.subarray(0, end).toString('utf8'));
      // No newline and nothing more to read: a file still being created, retried by the caller.
      if (bytesRead < size) return null;
    }
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Incremental readers
// ---------------------------------------------------------------------------

/**
 * Tracks one rollout file for the row. Each refresh stats it and reads only
 * the bytes appended since the last one, folding into a copy that is committed
 * with the offset so a read that fails part-way is retried, not folded twice.
 */
export class CodexRolloutReader {
  scan: CodexExecScan = createCodexExecScan();
  mtimeMs = 0;
  private offset = 0;

  constructor(readonly file: string) {}

  /** False when the file is gone (e.g. an ephemeral run, or pruned). */
  async refresh(): Promise<boolean> {
    let st: fs.Stats;
    try { st = await fs.promises.stat(this.file); } catch { return false; }
    if (!st.isFile()) return false;
    const fresh = st.size < this.offset;
    if (fresh) { this.scan = createCodexExecScan(); this.offset = 0; }
    this.mtimeMs = st.mtimeMs;
    if (st.size > this.offset) {
      try {
        const work = structuredClone(this.scan);
        const end = await readCompleteLines(this.file, this.offset, st.size, text => foldCodexExecText(work, text));
        this.scan = work;
        this.offset = end;
      } catch { /* retried from the same offset on the next refresh */ }
    }
    return true;
  }
}

/**
 * Incremental reader behind the viewer: a long rollout is read as its head
 * plus its tail, then only appended bytes (see `HeadTailReader`).
 */
export class CodexTranscriptReader extends HeadTailReader<CodexTranscriptState, ParsedCodexExecTranscript> {
  constructor() {
    super({ create: createCodexTranscriptState, fold: foldCodexTranscriptLines, finish: finishCodexTranscript });
  }
}
