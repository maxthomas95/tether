import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-opencode-home-'));
const warnings: Array<{ message: string; data?: Record<string, unknown> }> = [];

vi.mock('electron', () => ({
  app: { getPath: (key: string) => (key === 'home' ? fakeHome : '') },
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: (message: string, data?: Record<string, unknown>) => warnings.push({ message, data }),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { readCrushSessions } from './usage-reader';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-crush-'));
  tempDirs.push(dir);
  return dir;
}

function createCrushDb(dir: string): void {
  const db = new DatabaseSync(path.join(dir, 'crush.db'));
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      parent_session_id TEXT,
      title TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0.0,
      updated_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      directory TEXT,
      summary_message_id TEXT,
      todos TEXT
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      is_summary_message INTEGER,
      created_at INTEGER NOT NULL,
      model TEXT,
      provider TEXT
    );
  `);
  db.exec(`
    INSERT INTO sessions VALUES ('parent', NULL, 'Parent session', 3, 120, 45, 0.42, 1700000200, 1700000000, '/repo', NULL, NULL);
    INSERT INTO sessions VALUES ('child', 'parent', 'Child session', 1, 8, 3, 0.01, 1700000300, 1700000100, '/repo', NULL, NULL);
    INSERT INTO messages VALUES ('old', 'parent', 'assistant', 0, 1700000050, 'old-model', 'old-provider');
    INSERT INTO messages VALUES ('summary', 'parent', 'assistant', 1, 1700000400, 'summary-model', 'summary-provider');
    INSERT INTO messages VALUES ('latest', 'parent', 'assistant', 0, 1700000100, 'new-model', 'new-provider');
  `);
  db.close();
}

beforeEach(() => {
  warnings.length = 0;
  delete process.env.CRUSH_GLOBAL_DATA;
});

afterEach(() => {
  delete process.env.CRUSH_GLOBAL_DATA;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('readCrushSessions', () => {
  it('maps parent sessions and uses the latest non-summary assistant message', () => {
    const dir = makeTempDir();
    createCrushDb(dir);
    process.env.CRUSH_GLOBAL_DATA = dir;

    expect(readCrushSessions()).toEqual([{
      id: 'parent',
      title: 'Parent session',
      directory: '/repo',
      promptTokens: 120,
      completionTokens: 45,
      cost: 0.42,
      messageCount: 3,
      createdAt: '2023-11-14T22:13:20.000Z',
      updatedAt: '2023-11-14T22:16:40.000Z',
      model: 'new-model',
      provider: 'new-provider',
    }]);
  });

  it('returns an empty array when crush.db is missing', () => {
    process.env.CRUSH_GLOBAL_DATA = makeTempDir();
    expect(readCrushSessions()).toEqual([]);
  });

  it('returns an empty array for a corrupt database without throwing', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'crush.db'), 'not a sqlite database');
    process.env.CRUSH_GLOBAL_DATA = dir;

    expect(readCrushSessions()).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toBe('Failed to query crush.db');
  });
});
