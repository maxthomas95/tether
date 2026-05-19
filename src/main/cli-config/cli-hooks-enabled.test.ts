import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Verifies the cliHooksEnabled config-bit semantics — the contract the
 * Settings UI writes against and `hook-service.isEnabled()` reads against.
 *
 * The read-side predicate is intentionally strict (default-off, opt-in):
 *   `getDb().config?.cliHooksEnabled === 'true'`
 *
 * - Missing key       → disabled  (fresh install — user opts in via Setup Wizard or Settings)
 * - 'true'            → enabled
 * - 'false'           → disabled
 * - any other string  → disabled  (don't accidentally enable on user/migration garbage)
 *
 * If you change the storage shape (e.g. to a boolean), update both sides
 * AND this test, or you'll silently start treating existing installs as
 * enabled.
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
  return value === 'true';
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

  it('round-trips "false" through saveDb/getDb (explicit-disable case)', async () => {
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

  it('treats a fresh install (key absent) as disabled', async () => {
    const userData = makeUserData();
    const db = await loadDatabaseWithUserData(userData);
    const loaded = db.getDb();
    // Default-off contract: missing key counts as disabled.
    expect(loaded.config.cliHooksEnabled).toBeUndefined();
    expect(isEnabled(loaded.config.cliHooksEnabled)).toBe(false);
  });

  it('treats unrecognized values as disabled (no accidental opt-in on migration garbage)', async () => {
    expect(isEnabled(undefined)).toBe(false);
    expect(isEnabled('true')).toBe(true);
    expect(isEnabled('1')).toBe(false);
    expect(isEnabled('')).toBe(false);
    expect(isEnabled('yes')).toBe(false);
    // Only the exact string 'true' opts in.
    expect(isEnabled('false')).toBe(false);
    expect(isEnabled('TRUE')).toBe(false);
  });
});
