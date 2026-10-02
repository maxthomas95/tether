import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

let tempDirs: string[] = [];
const storage = {
  available: true,
  fail: false,
  isEncryptionAvailable: () => storage.available,
  encryptString: (value: string) => { if (storage.fail) throw new Error('Keychain failure'); return Buffer.from(`sealed:${value}`); },
  decryptString: (value: Buffer) => value.toString().slice(7),
};

async function loadDatabaseWithUserData(userData: string) {
  vi.resetModules();
  vi.doMock('electron', () => ({
    safeStorage: storage,
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
    storage.available = true; storage.fail = false;
  });

  it('migrates old credential locations once, preserves refs and decrypts every environment value', async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-db-'));
    tempDirs.push(userData);
    const original = {
      config: { jobsToken: 'jobs-fixture', theme: 'mocha', vaultToken: 'already-encrypted', vaultTokenExpiresAt: '2026-10-02T18:00:00Z' },
      defaultEnvVars: { CONNECTION_STRING: 'Password=fixture', REF: 'vault://secret/x#k' },
      environments: [{ id: 'e', config: JSON.stringify({ host: 'host', password: 'ssh-fixture' }), env_vars: '{"REGION":"west"}' }],
      launchProfiles: [{ id: 'p', env_vars: '{"OPAQUE":"profile-fixture"}', cli_flags: '[]' }],
      gitProviders: [{ token: 'git-fixture' }],
    };
    fs.writeFileSync(path.join(userData, 'data.json'), JSON.stringify(original));
    const db = await loadDatabaseWithUserData(userData);
    const loaded = db.getDb();
    const stored = fs.readFileSync(path.join(userData, 'data.json'), 'utf8');
    for (const secret of ['jobs-fixture', 'Password=fixture', 'ssh-fixture', 'profile-fixture', 'git-fixture']) expect(stored).not.toContain(secret);
    const { decryptEnvVarsRecord } = await import('./secret-storage');
    expect(decryptEnvVarsRecord(loaded.defaultEnvVars)).toEqual(original.defaultEnvVars);
    expect(JSON.parse(loaded.environments[0].config).passwordEncrypted).toBe(true);
    expect(loaded.config.vaultToken).toBe('already-encrypted');
    expect(loaded.config.vaultTokenExpiresAt).toBe(original.config.vaultTokenExpiresAt);
    expect(loaded.config.theme).toBe('mocha');
    db.closeDb(); db.getDb();
    expect(fs.readFileSync(path.join(userData, 'data.json'), 'utf8')).toBe(stored);
  });

  it.each(['unavailable', 'failure'])('preserves a valid database without a plaintext backup if encryption is %s', async mode => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-db-'));
    tempDirs.push(userData);
    const file = path.join(userData, 'data.json');
    const original = JSON.stringify({ defaultEnvVars: { FIRST: 'one', SECOND: 'two' }, config: {} });
    fs.writeFileSync(file, original);
    storage.available = mode !== 'unavailable'; storage.fail = mode === 'failure';
    const db = await loadDatabaseWithUserData(userData);
    expect(() => db.getDb()).toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(fs.readdirSync(userData)).toEqual(['data.json']);
    storage.available = true; storage.fail = false;
    expect(db.getDb().defaultEnvVars.FIRST).toMatch(/^tether-safe:v1:/);
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
