import { describe, expect, it, beforeEach, vi } from 'vitest';

const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((value: string) => Buffer.from(`enc:${value}`)),
  decryptString: vi.fn((value: Buffer) => value.toString('utf8').replace(/^enc:/, '')),
}));

vi.mock('electron', () => ({ safeStorage: safeStorageMock }));
vi.mock('./database');

import { __resetDb, getDb } from './__mocks__/database';
import { createGitProvider, getGitProvider, listGitProviders, updateGitProvider } from './git-provider-repo';
import { decryptSecretFromStorage, isEncryptedSecret } from './secret-storage';

describe('git-provider-repo', () => {
  beforeEach(() => {
    __resetDb();
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
    safeStorageMock.encryptString.mockClear();
    safeStorageMock.decryptString.mockClear();
  });

  it('encrypts provider tokens at rest', () => {
    const row = createGitProvider({
      name: 'GitHub',
      type: 'github',
      baseUrl: 'https://api.github.com',
      token: 'ghp_secret',
    });

    const raw = getDb().gitProviders[0];
    expect(raw.id).toBe(row.id);
    expect(isEncryptedSecret(raw.token)).toBe(true);
    expect(raw.token).not.toContain('ghp_secret');
    expect(decryptSecretFromStorage(raw.token, 'token')).toBe('ghp_secret');
  });

  it('keeps Vault token refs readable', () => {
    createGitProvider({
      name: 'GitHub',
      type: 'github',
      baseUrl: 'https://api.github.com',
      token: 'vault://secret/git#token',
    });
    expect(getDb().gitProviders[0].token).toBe('vault://secret/git#token');
  });

  it('lists providers by creation time without reordering stored rows', () => {
    for (const name of ['Second', 'First']) {
      createGitProvider({ name, type: 'github', baseUrl: 'https://api.github.com', token: 'vault://secret/git#token' });
    }
    const stored = getDb().gitProviders;
    stored[0].created_at = '2026-02-01T00:00:00.000Z';
    stored[1].created_at = '2026-01-01T00:00:00.000Z';
    Object.freeze(stored);

    expect(listGitProviders().map(row => row.name)).toEqual(['First', 'Second']);
    expect(getDb().gitProviders).toBe(stored);
    expect(stored.map(row => row.name)).toEqual(['Second', 'First']);
  });

  it('trims URL suffixes on create and update while preserving interior slashes', () => {
    const provider = createGitProvider({
      name: 'Gitea', type: 'gitea', baseUrl: 'https://example.test/git//api///', token: 'vault://secret/git#token',
    });
    expect(provider.baseUrl).toBe('https://example.test/git//api');

    const interior = 'https://example.test/' + '/'.repeat(100_000) + 'api';
    updateGitProvider(provider.id, { baseUrl: interior + '///' });
    expect(getGitProvider(provider.id)?.baseUrl).toBe(interior);
  });

  it('rewrites a legacy plaintext token on update', () => {
    getDb().gitProviders.push({
      id: 'gp-legacy',
      name: 'Legacy',
      type: 'github',
      baseUrl: 'https://api.github.com',
      organization: null,
      defaultProject: null,
      token: 'plain-old-token',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });

    updateGitProvider('gp-legacy', { name: 'Updated' });
    const updated = getGitProvider('gp-legacy')!;
    expect(updated.name).toBe('Updated');
    expect(isEncryptedSecret(updated.token)).toBe(true);
    expect(decryptSecretFromStorage(updated.token, 'token')).toBe('plain-old-token');
  });

  it('refuses to persist plaintext tokens when safeStorage is unavailable', () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    expect(() => createGitProvider({
      name: 'GitHub',
      type: 'github',
      baseUrl: 'https://api.github.com',
      token: 'ghp_secret',
    })).toThrow(/OS keychain/);
  });
});

