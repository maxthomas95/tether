import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
  return import('./database');
}

describe('database', () => {
  afterEach(async () => {
    try {
      const { closeLogger } = await import('../logger');
      closeLogger();
    } catch {
      // Logger may not have been imported if setup failed early.
    }
    vi.resetModules();
    vi.doUnmock('electron');
    vi.doUnmock('../logger');
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  it('moves malformed data.json aside before starting from defaults', async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-db-'));
    tempDirs.push(userData);
    const dbPath = path.join(userData, 'data.json');
    fs.writeFileSync(dbPath, '{bad json', 'utf-8');

    const db = await loadDatabaseWithUserData(userData);
    const loaded = db.getDb();

    expect(loaded.environments).toEqual([]);
    expect(fs.existsSync(dbPath)).toBe(false);
    const backups = fs.readdirSync(userData).filter(name => name.startsWith('data.json.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(userData, backups[0]), 'utf-8')).toBe('{bad json');

    loaded.config.theme = 'mocha';
    db.saveDb();

    expect(JSON.parse(fs.readFileSync(dbPath, 'utf-8')).config.theme).toBe('mocha');
    expect(fs.readFileSync(path.join(userData, backups[0]), 'utf-8')).toBe('{bad json');
  });
});
