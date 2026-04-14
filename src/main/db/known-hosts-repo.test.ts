import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./database');

import {
  listKnownHosts,
  findKnownHost,
  saveKnownHost,
  deleteKnownHost,
} from './known-hosts-repo';
import { __resetDb } from './__mocks__/database';

describe('known-hosts-repo', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetDb();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts empty', () => {
    expect(listKnownHosts()).toHaveLength(0);
  });

  it('saves a new entry with TOFU defaults', () => {
    const entry = saveKnownHost({ hostKey: 'example.com:22', keyHash: 'abc123' });
    expect(entry.id).toBeTruthy();
    expect(entry.hostKey).toBe('example.com:22');
    expect(entry.keyHash).toBe('abc123');
    expect(entry.keyType).toBe('unknown');
    expect(entry.trustedAt).toBe(entry.firstSeen);
    expect(listKnownHosts()).toHaveLength(1);
  });

  it('finds by hostKey', () => {
    saveKnownHost({ hostKey: 'host-a:22', keyHash: 'aa' });
    saveKnownHost({ hostKey: 'host-b:2222', keyHash: 'bb' });
    expect(findKnownHost('host-a:22')?.keyHash).toBe('aa');
    expect(findKnownHost('host-b:2222')?.keyHash).toBe('bb');
    expect(findKnownHost('missing:22')).toBeUndefined();
  });

  it('updating an existing host bumps trustedAt but keeps firstSeen', () => {
    const entry = saveKnownHost({ hostKey: 'host:22', keyHash: 'old' });
    const originalFirstSeen = entry.firstSeen;
    vi.advanceTimersByTime(60_000);
    const updated = saveKnownHost({ hostKey: 'host:22', keyHash: 'new', keyType: 'ssh-ed25519' });
    expect(updated.id).toBe(entry.id);
    expect(updated.keyHash).toBe('new');
    expect(updated.keyType).toBe('ssh-ed25519');
    expect(updated.firstSeen).toBe(originalFirstSeen);
    expect(updated.trustedAt).not.toBe(originalFirstSeen);
    expect(listKnownHosts()).toHaveLength(1);
  });

  it('preserves keyType when not supplied on update', () => {
    const entry = saveKnownHost({ hostKey: 'host:22', keyHash: 'h', keyType: 'ssh-rsa' });
    const updated = saveKnownHost({ hostKey: 'host:22', keyHash: 'h2' });
    expect(updated.keyType).toBe('ssh-rsa');
    expect(updated.id).toBe(entry.id);
  });

  it('lists hosts sorted by hostKey', () => {
    saveKnownHost({ hostKey: 'zeta:22', keyHash: 'z' });
    saveKnownHost({ hostKey: 'alpha:22', keyHash: 'a' });
    saveKnownHost({ hostKey: 'mu:22', keyHash: 'm' });
    const list = listKnownHosts();
    expect(list.map(h => h.hostKey)).toEqual(['alpha:22', 'mu:22', 'zeta:22']);
  });

  it('deletes by id', () => {
    const a = saveKnownHost({ hostKey: 'a:22', keyHash: 'a' });
    saveKnownHost({ hostKey: 'b:22', keyHash: 'b' });
    deleteKnownHost(a.id);
    expect(listKnownHosts()).toHaveLength(1);
    expect(findKnownHost('a:22')).toBeUndefined();
    expect(findKnownHost('b:22')).toBeDefined();
  });

  it('delete is a no-op for unknown id', () => {
    saveKnownHost({ hostKey: 'a:22', keyHash: 'a' });
    deleteKnownHost('nonexistent');
    expect(listKnownHosts()).toHaveLength(1);
  });
});
