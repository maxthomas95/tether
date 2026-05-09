import path from 'node:path';
import { app } from 'electron';
import { createLogger } from '../logger';

const log = createLogger('opencode-usage');

export interface OpenCodeSessionUsage {
  id: string;
  title: string;
  directory: string;
  promptTokens: number;
  completionTokens: number;
  cost: number;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  model?: string;
  provider?: string;
}

/**
 * Locate the Crush (formerly OpenCode) SQLite database.
 *
 * Crush stores session data in `{dataDir}/crush.db`. The data directory
 * defaults to `~/.local/share/crush` on Unix and `%LOCALAPPDATA%\crush`
 * on Windows, but can be overridden via `CRUSH_GLOBAL_DATA`.
 */
function getCrushDbPath(): string | null {
  const override = process.env.CRUSH_GLOBAL_DATA;
  if (override) {
    const candidate = path.join(override, 'crush.db');
    return candidate;
  }

  // On Windows, Electron's app.getPath('userData') points to
  // %APPDATA%\Tether, not the system-wide LOCALAPPDATA. Use the
  // environment variable directly.
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      return path.join(localAppData, 'crush', 'crush.db');
    }
    // Fallback: use the home directory
    return path.join(app.getPath('home'), '.local', 'share', 'crush', 'crush.db');
  }

  // Unix: ~/.local/share/crush/crush.db
  return path.join(app.getPath('home'), '.local', 'share', 'crush', 'crush.db');
}

/**
 * Read all sessions from the Crush SQLite database.
 *
 * Returns an empty array if the database doesn't exist, can't be opened,
 * or the query fails. This is a read-only operation — we never modify
 * the crush.db file.
 *
 * The `sessions` table schema (from Crush migrations):
 *   id TEXT PRIMARY KEY,
 *   parent_session_id TEXT,
 *   title TEXT NOT NULL,
 *   message_count INTEGER NOT NULL DEFAULT 0,
 *   prompt_tokens INTEGER NOT NULL DEFAULT 0,
 *   completion_tokens INTEGER NOT NULL DEFAULT 0,
 *   cost REAL NOT NULL DEFAULT 0.0,
 *   updated_at INTEGER NOT NULL,  -- Unix timestamp (seconds)
 *   created_at INTEGER NOT NULL,
 *   directory TEXT,               -- working directory
 *   summary_message_id TEXT,
 *   todos TEXT
 *
 * The `messages` table has `model` and `provider` columns per message.
 * We aggregate the most recent non-summary assistant message's model
 * for each session.
 */
export function readCrushSessions(): OpenCodeSessionUsage[] {
  const dbPath = getCrushDbPath();
  if (!dbPath) {
    log.warn('Could not determine crush.db path');
    return [];
  }

  // Lazy require to avoid loading better-sqlite3 at module init time.
  // The native module ABI can be fragile with Electron.
  let Database: typeof import('better-sqlite3');
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    Database = require('better-sqlite3');
  } catch (err) {
    log.warn('better-sqlite3 not available, skipping Crush usage read', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  const fs = require('node:fs');
  if (!fs.existsSync(dbPath)) {
    return [];
  }

  let db: import('better-sqlite3').Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    log.warn('Failed to open crush.db', {
      path: dbPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  try {
    // Read sessions (exclude sub-agent/child sessions to avoid double-counting)
    const rows = db.prepare(`
      SELECT
        s.id,
        s.title,
        s.directory,
        s.prompt_tokens,
        s.completion_tokens,
        s.cost,
        s.message_count,
        s.created_at,
        s.updated_at,
        m.model,
        m.provider
      FROM sessions s
      LEFT JOIN messages m ON m.id = (
        SELECT m2.id FROM messages m2
        WHERE m2.session_id = s.id
          AND m2.role = 'assistant'
          AND m2.is_summary_message != 1
        ORDER BY m2.created_at DESC
        LIMIT 1
      )
      WHERE s.parent_session_id IS NULL
      ORDER BY s.updated_at DESC
    `).all() as Array<{
      id: string;
      title: string;
      directory: string | null;
      prompt_tokens: number;
      completion_tokens: number;
      cost: number;
      message_count: number;
      created_at: number;
      updated_at: number;
      model: string | null;
      provider: string | null;
    }>;

    return rows.map(row => ({
      id: row.id,
      title: row.title,
      directory: row.directory ?? '',
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      cost: row.cost,
      messageCount: row.message_count,
      createdAt: new Date(row.created_at * 1000).toISOString(),
      updatedAt: new Date(row.updated_at * 1000).toISOString(),
      model: row.model ?? undefined,
      provider: row.provider ?? undefined,
    }));
  } catch (err) {
    log.warn('Failed to query crush.db', {
      path: dbPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}
