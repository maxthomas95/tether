import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LaunchProfileRow } from '../db/database';

const electronState = vi.hoisted(() => ({
  userData: '',
  encryptionAvailable: true,
  decryptFails: false,
}));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name !== 'userData') throw new Error(`unexpected app path: ${name}`);
      return electronState.userData;
    },
  },
  safeStorage: {
    isEncryptionAvailable: () => electronState.encryptionAvailable,
    encryptString: (value: string) => Buffer.from([...value].reverse().join(''), 'utf8'),
    decryptString: (value: Buffer) => {
      if (electronState.decryptFails) throw new Error('decrypt failed');
      return [...value.toString('utf8')].reverse().join('');
    },
  },
}));

import { closeDb, getDb } from '../db/database';
import {
  captureLaunchIntent,
  createLaunchSnapshot,
  persistLaunchSnapshot,
  prepareLaunchSnapshot,
  readLaunchIntent,
} from './launch-snapshots';

function profile(overrides: Partial<LaunchProfileRow> = {}): LaunchProfileRow {
  return {
    id: 'profile-1',
    name: 'Work',
    env_vars: '{}',
    cli_flags: '[]',
    cli_flags_per_tool: '{}',
    is_default: false,
    sort_order: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('launch snapshots', () => {
  beforeEach(() => {
    // The database caches its file path, so reuse this isolated temp directory.
    if (!electronState.userData) {
      electronState.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-launch-snapshots-'));
    }
    fs.mkdirSync(electronState.userData, { recursive: true });
    electronState.encryptionAvailable = true;
    electronState.decryptFails = false;
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(electronState.userData, { recursive: true, force: true });
  });

  it('roundtrips encrypted launch intent through data.json reload without plaintext leakage', () => {
    getDb().launchProfiles.push(profile());
    const env = { ARBITRARY_NAME: 'plain-secret', VAULTED: 'vault://secret/tether#token' };
    const cliArgs = ['--set', 'password=super-secret'];
    const disabledInheritedFlags = ['--model=old'];
    const snapshotId = createLaunchSnapshot(captureLaunchIntent({
      workingDir: '/repo',
      profileId: 'profile-1',
      env,
      cliArgs,
      disabledInheritedFlags,
    }));
    expect(snapshotId).toBeTruthy();
    env.ARBITRARY_NAME = 'mutated';
    cliArgs.push('--mutated');
    disabledInheritedFlags.push('--other');

    const raw = fs.readFileSync(path.join(electronState.userData, 'data.json'), 'utf8');
    expect(raw).toContain('tether-safe:v1:');
    expect(raw).not.toContain('plain-secret');
    expect(raw).not.toContain('super-secret');
    expect(raw).not.toContain('ARBITRARY_NAME');

    closeDb();
    const restored = readLaunchIntent(snapshotId!);
    expect(restored).toEqual({
      version: 1,
      profileId: 'profile-1',
      env: { ARBITRARY_NAME: 'plain-secret', VAULTED: 'vault://secret/tether#token' },
      cliArgs: ['--set', 'password=super-secret'],
      disabledInheritedFlags: ['--model=old'],
    });
  });

  it('does not create snapshots for ordinary launches without launch intent', () => {
    expect(captureLaunchIntent({ workingDir: '/repo' })).toBeNull();
    expect(createLaunchSnapshot(null)).toBeUndefined();
    expect(getDb().launchSnapshots).toEqual({});
  });

  it('preserves environment keys that match object prototype names', () => {
    const snapshotId = createLaunchSnapshot(captureLaunchIntent({
      workingDir: '/repo',
      env: JSON.parse('{"__proto__":"original-value","constructor":"other-value"}'),
    }));
    const restored = readLaunchIntent(snapshotId!);
    expect(Object.entries(restored.env!)).toEqual([
      ['__proto__', 'original-value'],
      ['constructor', 'other-value'],
    ]);
  });

  it('captures explicit empty overrides as a launch intent', () => {
    expect(captureLaunchIntent({ workingDir: '/repo', env: {}, cliArgs: [], disabledInheritedFlags: [] })).toEqual({
      version: 1,
      env: {},
      cliArgs: [],
      disabledInheritedFlags: [],
    });
  });

  it('rejects missing, plaintext, malformed, unsupported, decryption, deleted-profile, and keychain failures', () => {
    expect(() => readLaunchIntent('missing')).toThrow(/not found/);

    getDb().launchProfiles.push(profile());
    getDb().launchSnapshots.plain = {
      id: 'plain',
      version: 1,
      encryptedIntent: JSON.stringify({ version: 1, env: {} }),
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    expect(() => readLaunchIntent('plain')).toThrow(/invalid/);

    for (const [id, payload] of Object.entries({
      malformed: '{nope',
      schema: JSON.stringify({ version: 1, env: { BAD: 42 } }),
      unsupported: JSON.stringify({ version: 2, env: {} }),
    })) {
      const row = prepareLaunchSnapshot({ version: 1, env: {} });
      expect(row).toBeTruthy();
      persistLaunchSnapshot({ ...row!, id, encryptedIntent: `tether-safe:v1:${Buffer.from([...payload].reverse().join('')).toString('base64')}` });
      expect(() => readLaunchIntent(id)).toThrow();
    }

    const decryptRow = prepareLaunchSnapshot({ version: 1, env: { TOKEN: 'secret' } });
    persistLaunchSnapshot({ ...decryptRow!, id: 'decrypt-fails' });
    electronState.decryptFails = true;
    expect(() => readLaunchIntent('decrypt-fails')).toThrow(/could not be decrypted/);
    electronState.decryptFails = false;

    const profileRow = prepareLaunchSnapshot({ version: 1, profileId: 'profile-1' });
    persistLaunchSnapshot({ ...profileRow!, id: 'deleted-profile' });
    getDb().launchProfiles = [];
    expect(() => readLaunchIntent('deleted-profile')).toThrow(/profile no longer exists/);

    electronState.encryptionAvailable = false;
    expect(() => readLaunchIntent('decrypt-fails')).toThrow(/could not be decrypted/);
    expect(() => prepareLaunchSnapshot({ version: 1, env: { TOKEN: 'secret' } })).toThrow(/keychain/);
  });
});
