import fs from 'node:fs';
import path from 'node:path';
import type { SessionDailyUsage, SessionUsage, UsageModelBreakdown } from '../../shared/types';

export type NativeOpenCodeUsageRead =
  | { status: 'available'; sessions: SessionUsage[]; unavailableSessionIds: string[] }
  | { status: 'unavailable'; reason: 'missing' | 'unsupported' | 'read-failed' | 'limit' };

interface ReadOptions {
  maxSessions?: number;
  /** Combined message and part records, including records without usage. */
  maxRecords?: number;
  now?: () => number;
}

type Row = Record<string, unknown>;
interface NativeSession {
  created: number;
  usage: SessionUsage;
  events: UsageEvent[];
}
interface NativeMessage {
  sessionId: string;
  created: number;
  completed?: number;
  role: string;
  model?: string;
  copied: boolean;
}
interface UsageEvent {
  id: string;
  timestamp: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cost: number;
}

// All JSON projections are type-gated scalars. Never select data, content, or
// entire nested objects, even if an unexpected schema puts an object here.
function scalar(field: string, kind: 'text' | 'number'): string {
  const type = `json_type(data, '$.${field}')`;
  const value = `json_extract(data, '$.${field}')`;
  return `CASE WHEN json_valid(data) THEN CASE WHEN ${type} ${kind === 'text'
    ? "= 'text'" : "IN ('integer', 'real')"} THEN ${kind === 'text' ? value : `CAST(${value} AS REAL)`} END END`;
}

function timestampColumn(field: string): string {
  return `CASE WHEN typeof(${field}) IN ('integer', 'real') THEN CAST(${field} AS REAL) END AS ${field}`;
}

const VALID_DATA = "CASE WHEN json_valid(data) THEN json_type(data) = 'object' ELSE 0 END AS valid_data";
const MESSAGE_QUERY = `SELECT id, session_id, ${timestampColumn('time_created')}, ${timestampColumn('time_updated')},
  ${VALID_DATA}, ${scalar('role', 'text')} AS role,
  ${scalar('providerID', 'text')} AS provider, ${scalar('modelID', 'text')} AS model,
  ${scalar('time.created', 'number')} AS created, ${scalar('time.completed', 'number')} AS completed,
  CASE WHEN json_valid(data) THEN json_type(data, '$.time.completed') ELSE 'invalid' END AS completed_type
  FROM message ORDER BY id LIMIT ?`;
const PART_QUERY = `SELECT id, session_id, message_id, ${timestampColumn('time_created')}, ${timestampColumn('time_updated')},
  ${VALID_DATA}, ${scalar('type', 'text')} AS type, ${scalar('cost', 'number')} AS cost,
  ${scalar('tokens.input', 'number')} AS input_tokens, ${scalar('tokens.output', 'number')} AS output_tokens,
  ${scalar('tokens.reasoning', 'number')} AS reasoning_tokens,
  ${scalar('tokens.cache.read', 'number')} AS cache_read_tokens,
  ${scalar('tokens.cache.write', 'number')} AS cache_creation_tokens
  FROM part ORDER BY id LIMIT ?`;

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function counter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function timestamp(value: unknown): value is number {
  return counter(value) && value <= 8_640_000_000_000_000;
}

function validTimes(row: Row): boolean {
  return timestamp(row.time_created) && timestamp(row.time_updated) && row.time_updated >= row.time_created;
}

function emptyModel(model: string): UsageModelBreakdown {
  return { model, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0 };
}

function addTokens(target: UsageModelBreakdown | SessionUsage | SessionDailyUsage, event: UsageEvent): void {
  for (const field of ['inputTokens', 'outputTokens', 'reasoningTokens', 'cacheCreationTokens', 'cacheReadTokens'] as const) {
    const sum = (target[field] ?? 0) + event[field];
    if (!counter(sum)) throw new Error('Invalid usage total');
    target[field] = sum;
  }
  if ('cost' in target) {
    target.cost += event.cost;
    if (!Number.isFinite(target.cost)) throw new Error('Invalid usage total');
  } else {
    target.totalCost += event.cost;
    if (!Number.isFinite(target.totalCost)) throw new Error('Invalid usage total');
  }
}

function addModel(models: Map<string, UsageModelBreakdown>, event: UsageEvent): void {
  let model = models.get(event.model);
  if (!model) {
    model = emptyModel(event.model);
    models.set(event.model, model);
  }
  addTokens(model, event);
}

function buildUsage(session: NativeSession): SessionUsage {
  const usage = session.usage;
  const days = new Map<string, SessionDailyUsage>();
  const models = new Map<string, UsageModelBreakdown>();
  const dayModels = new Map<string, Map<string, UsageModelBreakdown>>();
  session.events.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
  for (const event of session.events) {
    const at = new Date(event.timestamp).toISOString();
    const date = at.slice(0, 10);
    let day = days.get(date);
    if (!day) {
      day = { date, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
        totalCost: 0, messageCount: 0, models: [] };
      days.set(date, day);
      dayModels.set(date, new Map());
    }
    addTokens(usage, event);
    addTokens(day, event);
    addModel(models, event);
    addModel(dayModels.get(date)!, event);
    usage.messageCount++;
    day.messageCount++;
    usage.firstMessageAt ??= at;
    usage.lastMessageAt = at;
    usage.currentModel = event.model;
  }
  usage.models = [...models.values()].sort((a, b) => a.model.localeCompare(b.model));
  usage.daily = [...days.values()];
  for (const day of usage.daily) day.models = [...dayModels.get(day.date)!.values()].sort((a, b) => a.model.localeCompare(b.model));
  return usage;
}

/**
 * Read-only snapshots of native OpenCode v1.14.44 session/message/part tables.
 * Step-finish parts are authoritative: message.cost accumulates while message
 * tokens are overwritten after each step. Summary and child work remain billed
 * in their own sessions; parent totals do not contain child spend.
 *
 * Forks preserve message.time.created but assign copied parts fresh persistence
 * times. Excluding messages older than their session assumes a consistent host
 * clock; equal timestamps with usage have no reliable provenance and are withheld.
 * Parts after message completion, or without a completion boundary, use the
 * original message day as approximate timing: imports regenerate persistence
 * timestamps, including for unfinished messages. No transcript content is
 * selected, returned, or logged.
 */
export function readNativeOpenCodeUsage(dbPath: string, options: ReadOptions = {}): NativeOpenCodeUsageRead {
  if (!dbPath || dbPath === ':memory:' || !path.isAbsolute(dbPath)) return { status: 'unavailable', reason: 'unsupported' };
  const maxSessions = options.maxSessions ?? 5_000;
  const maxRecords = options.maxRecords ?? 100_000;
  if (!counter(maxSessions) || !counter(maxRecords) || maxSessions === Number.MAX_SAFE_INTEGER || maxRecords === Number.MAX_SAFE_INTEGER) {
    return { status: 'unavailable', reason: 'limit' };
  }
  try {
    if (!fs.statSync(dbPath).isFile()) return { status: 'unavailable', reason: 'unsupported' };
  } catch (error) {
    return { status: 'unavailable', reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'read-failed' };
  }

  let DatabaseSync: typeof import('node:sqlite').DatabaseSync;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    return { status: 'unavailable', reason: 'unsupported' };
  }

  let db: import('node:sqlite').DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, allowExtension: false, timeout: 1_000 });
    // A read transaction gives all three bounded queries one consistent snapshot.
    db.exec('BEGIN');
    const schema: Record<string, string[]> = {
      session: ['id', 'directory', 'parent_id', 'time_created', 'time_updated'],
      message: ['id', 'session_id', 'time_created', 'time_updated', 'data'],
      part: ['id', 'session_id', 'message_id', 'time_created', 'time_updated', 'data'],
    };
    for (const [table, columns] of Object.entries(schema)) {
      const found = db.prepare(`PRAGMA table_info(${table})`).all();
      if (columns.some(column => !found.some(info => info.name === column))) return { status: 'unavailable', reason: 'unsupported' };
    }
    const sessionRows = db.prepare(`SELECT id, directory, parent_id, ${timestampColumn('time_created')},
      ${timestampColumn('time_updated')} FROM session ORDER BY id LIMIT ?`).all(maxSessions + 1) as Row[];
    if (sessionRows.length > maxSessions) return { status: 'unavailable', reason: 'limit' };
    const messageRows = db.prepare(MESSAGE_QUERY).all(maxRecords + 1) as Row[];
    if (messageRows.length > maxRecords) return { status: 'unavailable', reason: 'limit' };
    const partRows = db.prepare(PART_QUERY).all(maxRecords - messageRows.length + 1) as Row[];
    if (messageRows.length + partRows.length > maxRecords) return { status: 'unavailable', reason: 'limit' };

    const observed = (options.now ?? Date.now)();
    if (!timestamp(observed)) return { status: 'unavailable', reason: 'read-failed' };
    const observedAt = new Date(observed).toISOString();
    const sessions = new Map<string, NativeSession>();
    const unavailable = new Set<string>();
    for (const row of sessionRows) {
      if (!text(row.id)) return { status: 'unavailable', reason: 'read-failed' };
      if (sessions.has(row.id) || !text(row.directory) || !validTimes(row) || (row.parent_id !== null && !text(row.parent_id))) {
        unavailable.add(row.id);
        continue;
      }
      sessions.set(row.id, {
        created: row.time_created as number,
        events: [],
        usage: { sessionId: row.id, cliTool: 'opencode', workingDir: row.directory, collectionStatus: 'available',
          usageSource: 'native-opencode', costSource: 'reported', observedAt, inputTokens: 0, outputTokens: 0,
          reasoningTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalCost: 0, models: [], daily: [],
          dayTiming: 'event', currentModel: null, messageCount: 0, firstMessageAt: null, lastMessageAt: null, parsedByteOffset: 0 },
      });
    }

    const messages = new Map<string, NativeMessage>();
    for (const row of messageRows) {
      if (!text(row.session_id)) return { status: 'unavailable', reason: 'read-failed' };
      const sessionId = row.session_id;
      const session = sessions.get(sessionId);
      if (!session || unavailable.has(sessionId)) { unavailable.add(sessionId); continue; }
      if (!text(row.id) || !validTimes(row) || row.valid_data !== 1 || !timestamp(row.created)
        || (row.role !== 'assistant' && row.role !== 'user')
        || (row.completed_type !== null && (!timestamp(row.completed) || row.completed < row.created))) {
        unavailable.add(sessionId);
        continue;
      }
      const copied = row.created < session.created;
      if (row.role === 'assistant' && !copied && (!text(row.provider) || !text(row.model))) {
        unavailable.add(sessionId);
        continue;
      }
      if (messages.has(row.id)) {
        unavailable.add(messages.get(row.id)!.sessionId);
        unavailable.add(sessionId);
        continue;
      }
      messages.set(row.id, { sessionId, created: row.created, completed: row.completed_type === null ? undefined : row.completed as number,
        role: row.role, model: row.role === 'assistant' ? `${row.provider}/${row.model}` : undefined, copied });
    }

    for (const row of partRows) {
      if (!text(row.session_id)) return { status: 'unavailable', reason: 'read-failed' };
      const sessionId = row.session_id;
      const session = sessions.get(sessionId);
      if (!session || unavailable.has(sessionId)) { unavailable.add(sessionId); continue; }
      const message = text(row.message_id) ? messages.get(row.message_id) : undefined;
      if (!text(row.id) || !validTimes(row) || row.valid_data !== 1 || !text(row.type) || !message || message.sessionId !== sessionId) {
        unavailable.add(sessionId);
        if (message && message.sessionId !== sessionId) unavailable.add(message.sessionId);
        continue;
      }
      if (message.copied || row.type !== 'step-finish') continue;
      if (message.role !== 'assistant' || !message.model || message.created === session.created
        || !counter(row.input_tokens) || !counter(row.output_tokens) || !counter(row.reasoning_tokens)
        || !counter(row.cache_read_tokens) || !counter(row.cache_creation_tokens)
        || typeof row.cost !== 'number' || !Number.isFinite(row.cost) || row.cost < 0
        || (row.time_created as number) < message.created || !counter(row.output_tokens + row.reasoning_tokens)) {
        unavailable.add(sessionId);
        continue;
      }
      let eventTime = row.time_created as number;
      if (message.completed === undefined || eventTime > message.completed) {
        eventTime = message.created;
        session.usage.dayTiming = 'snapshot';
      }
      session.events.push({ id: row.id, timestamp: eventTime, model: message.model, inputTokens: row.input_tokens,
        outputTokens: row.output_tokens + row.reasoning_tokens, reasoningTokens: row.reasoning_tokens,
        cacheReadTokens: row.cache_read_tokens, cacheCreationTokens: row.cache_creation_tokens, cost: row.cost });
    }

    const result: SessionUsage[] = [];
    for (const [id, session] of sessions) {
      if (unavailable.has(id)) continue;
      try { result.push(buildUsage(session)); } catch { unavailable.add(id); }
    }
    return { status: 'available', sessions: result, unavailableSessionIds: [...unavailable].sort() };
  } catch {
    return { status: 'unavailable', reason: 'read-failed' };
  } finally {
    // Closing rolls back the read transaction. Never issue a write or migration.
    try { db?.close(); } catch { /* read health is already represented above */ }
  }
}
