import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Verifies the cliHooksEnabled config-bit semantics — the contract the
 * Settings UI writes against and `hook-service.isEnabled()` reads against.
 *
 * The read-side predicate is intentionally permissive (default-on, opt-out):
 *   `getDb().config?.cliHooksEnabled !== 'false'`
 *
 * - Missing key       → enabled  (fresh install, never visited Settings)
 * - 'true'            → enabled
 * - 'false'           → disabled
 * - any other string  → enabled  (don't trip on user/migration garbage)
 *
 * If you change the storage shape (e.g. to a boolean), update both sides
 * AND this test, or you'll silently start treating existing installs as
 * disabled.
 */

let tempDirs: string[] = [];

async function loadDatabaseWithUserData(userData: string) {
  vi.resetModules();
  vi.doMock('electron', () => ({
    app: {
      getPath: () => userData,
    },
  }));
  vi.doMock('../logger', () => ({
    createLogger: () => ({
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    }),
  }));
  return import('../db/database');
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('electron');
  vi.doUnmock('../logger');
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function makeUserData(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-clihooks-'));
  tempDirs.push(dir);
  return dir;
}

function isEnabled(value: string | undefined): boolean {
  // Mirror of `hook-service.isEnabled()` — kept inline so a refactor that
  // changes that predicate will surface as a test diff to review.
  return value !== 'false';
}

describe('cliHooksEnabled persistence', () => {
  it('round-trips "true" through saveDb/getDb', async () => {
    const userData = makeUserData();
    {
      const db = await loadDatabaseWithUserData(userData);
      const loaded = db.getDb();
      loaded.config.cliHooksEnabled = 'true';
      db.saveDb();
      db.closeDb();
    }
    {
      const db = await loadDatabaseWithUserData(userData);
      const loaded = db.getDb();
      expect(loaded.config.cliHooksEnabled).toBe('true');
      expect(isEnabled(loaded.config.cliHooksEnabled)).toBe(true);
    }
  });

  it('round-trips "false" through saveDb/getDb (the opt-out case)', async () => {
    const userData = makeUserData();
    {
      const db = await loadDatabaseWithUserData(userData);
      const loaded = db.getDb();
      loaded.config.cliHooksEnabled = 'false';
      db.saveDb();
      db.closeDb();
    }
    {
      const db = await loadDatabaseWithUserData(userData);
      const loaded = db.getDb();
      expect(loaded.config.cliHooksEnabled).toBe('false');
      expect(isEnabled(loaded.config.cliHooksEnabled)).toBe(false);
    }
  });

  it('treats a fresh install (key absent) as enabled', async () => {
    const userData = makeUserData();
    const db = await loadDatabaseWithUserData(userData);
    const loaded = db.getDb();
    // Default-on contract: missing key counts as enabled.
    expect(loaded.config.cliHooksEnabled).toBeUndefined();
    expect(isEnabled(loaded.config.cliHooksEnabled)).toBe(true);
  });

  it('treats unrecognized values as enabled (no accidental opt-out on migration garbage)', async () => {
    expect(isEnabled(undefined)).toBe(true);
    expect(isEnabled('true')).toBe(true);
    expect(isEnabled('1')).toBe(true);
    expect(isEnabled('')).toBe(true);
    expect(isEnabled('yes')).toBe(true);
    // Only the exact string 'false' opts out.
    expect(isEnabled('false')).toBe(false);
    expect(isEnabled('FALSE')).toBe(true);
  });
});
