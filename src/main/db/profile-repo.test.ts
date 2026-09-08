import { beforeEach, expect, it, vi } from 'vitest';
import type { LaunchProfileRow } from './database';

const db = vi.hoisted(() => ({ launchProfiles: [] as LaunchProfileRow[] }));
vi.mock('./database', () => ({ getDb: () => db, saveDb: vi.fn() }));
vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }));
vi.mock('../vault/vault-resolver', () => ({ isVaultRef: (value: string) => value.startsWith('vault://') }));
import { createProfile, updateProfile, listProfiles } from './profile-repo';

beforeEach(() => { db.launchProfiles = []; });

it('sorts by display order and creation time without reordering stored profiles', () => {
  createProfile({ name: 'Last' });
  createProfile({ name: 'Second' });
  createProfile({ name: 'First' });
  const stored = db.launchProfiles;
  stored[0].sort_order = 1;
  stored[1].created_at = '2026-02-01T00:00:00.000Z';
  stored[2].created_at = '2026-01-01T00:00:00.000Z';
  Object.freeze(stored);

  expect(listProfiles().map(row => row.name)).toEqual(['First', 'Second', 'Last']);
  expect(db.launchProfiles).toBe(stored);
  expect(stored.map(row => row.name)).toEqual(['Last', 'Second', 'First']);
});

it('replaces the default when creating a default profile and preserves unrelated values', () => {
  const original = createProfile({ name: 'original', isDefault: true, envVars: { REGION: 'west' } });
  createProfile({ name: 'replacement', isDefault: true });
  expect(listProfiles().filter(profile => profile.is_default).map(profile => profile.name)).toEqual(['replacement']);
  expect(listProfiles().find(profile => profile.id === original.id)).toEqual({ ...original, is_default: false });
});

it('can make an existing profile default without changing its flags or environment', () => {
  createProfile({ name: 'original', isDefault: true });
  const replacement = createProfile({ name: 'replacement', cliFlagsPerTool: { codex: ['--full-auto'] }, envVars: { REGION: 'east' } });
  updateProfile(replacement.id, { isDefault: true });
  const profiles = listProfiles();
  expect(profiles.filter(profile => profile.is_default).map(profile => profile.id)).toEqual([replacement.id]);
  expect(profiles.find(profile => profile.id === replacement.id)).toMatchObject({
    env_vars: replacement.env_vars, cli_flags_per_tool: replacement.cli_flags_per_tool,
  });
});
