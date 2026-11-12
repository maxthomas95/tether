import { open } from 'node:fs/promises';
import path from 'node:path';
import { scrubLogText } from '../diagnostics/scrub';

/** How far back a submitted prompt may be, and how much of it may be shared. */
export const PIP_PROMPT_MAX_AGE_MS = 5 * 60_000;
export const PIP_PROMPT_MAX_CHARS = 400;

/** Scrubbing is best effort, not a promise that arbitrary secrets can be detected. */
export function scrubPromptExcerpt(text: string): string {
  return scrubLogText(text).replace(/\b(sk-[a-z0-9_-]{16,}|(?:password|token|api[_-]?key)\s*[:=]\s*\S+)/gi, '[REDACTED]')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').slice(0, PIP_PROMPT_MAX_CHARS);
}

/** A typed prompt from one Claude or Codex transcript row, or null for anything else (assistant, tool or meta rows). */
function transcriptPrompt(row: Record<string, unknown> | null): unknown {
  if (row?.type === 'event_msg') {
    const payload = row.payload as Record<string, unknown> | undefined;
    return payload?.type === 'user_message' ? payload.message : null;
  }
  if (row?.type === 'user' && !row.isMeta) return (row.message as Record<string, unknown> | undefined)?.content;
  return null;
}

/** Read only a bounded tail of an already-attributed local transcript. Never parse PTY output. */
export async function readRecentPrompt(filePath: string, now = Date.now()): Promise<string | null> {
  const file = await open(filePath, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) return null;
    const start = Math.max(0, stat.size - 64 * 1024);
    const buffer = Buffer.alloc(Math.min(stat.size, 64 * 1024));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    if (start > 0) lines.shift();
    // Newest first.
    for (let index = lines.length - 1; index >= 0; index--) {
      let row;
      try { row = JSON.parse(lines[index]); } catch { continue; }
      const time = Date.parse(row?.timestamp);
      if (!Number.isFinite(time) || now - time > PIP_PROMPT_MAX_AGE_MS || time > now + 1000) continue;
      const text = transcriptPrompt(row);
      if (typeof text === 'string' && text.trim()) return scrubPromptExcerpt(text);
    }
    return null;
  } finally {
    await file.close();
  }
}

type Row = Record<string, unknown>;
// Only typed scalars leave SQLite: the role of a message, and the type, text and synthetic flag of its parts.
const LATEST_USER_MESSAGE = `SELECT id FROM message
  WHERE session_id = ? AND time_created >= ? AND time_created <= ?
    AND json_valid(data) AND json_type(data, '$.role') = 'text' AND json_extract(data, '$.role') = 'user'
  ORDER BY time_created DESC, id DESC LIMIT 1`;
const PROMPT_PARTS = `SELECT
  CASE WHEN json_valid(data) AND json_type(data, '$.type') = 'text' THEN json_extract(data, '$.type') END AS type,
  CASE WHEN json_valid(data) AND json_type(data, '$.text') = 'text' THEN substr(json_extract(data, '$.text'), 1, 4000) END AS text,
  CASE WHEN json_valid(data) THEN json_type(data, '$.synthetic') END AS synthetic
  FROM part WHERE session_id = ? AND message_id = ? ORDER BY id LIMIT 50`;

/**
 * The latest prompt typed into a local OpenCode session, from OpenCode's own database opened read-only.
 * Two bounded, indexed queries: the newest user message from the past five minutes, then its text parts.
 * Synthetic parts (OpenCode's own reminders and attachments) and every other part type are skipped.
 */
export function readRecentOpenCodePrompt(dbPath: string, sessionId: string, now = Date.now()): string | null {
  if (!path.isAbsolute(dbPath) || !sessionId || sessionId.length > 200) return null;
  let DatabaseSync: typeof import('node:sqlite').DatabaseSync;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    return null;
  }
  let db: import('node:sqlite').DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, allowExtension: false, timeout: 1_000 });
    const message = db.prepare(LATEST_USER_MESSAGE).get(sessionId, now - PIP_PROMPT_MAX_AGE_MS, now + 1000) as Row | undefined;
    if (!message || typeof message.id !== 'string') return null;
    const parts = db.prepare(PROMPT_PARTS).all(sessionId, message.id) as Row[];
    const text = parts
      .filter(part => part.type === 'text' && part.synthetic !== 'true' && typeof part.text === 'string')
      .map(part => (part.text as string).trim())
      .filter(Boolean)
      .join('\n');
    return text ? scrubPromptExcerpt(text) : null;
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* nothing was written */ }
  }
}
