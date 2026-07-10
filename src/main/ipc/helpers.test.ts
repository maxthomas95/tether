import { describe, expect, it, vi } from 'vitest';

const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => false),
  encryptString: vi.fn(),
  decryptString: vi.fn(),
}));

vi.mock('electron', () => ({ safeStorage: safeStorageMock }));
vi.mock('../vault/vault-resolver', () => ({
  isVaultRef: (value: string) => value.startsWith('vault://'),
  resolveRef: vi.fn(),
}));

import { decryptConfigPassword, encryptConfigPassword } from './helpers';

describe('SSH config password helpers', () => {
  it('rejects plaintext password persistence without an OS keychain', () => {
    expect(() => encryptConfigPassword({ password: 'secret' }))
      .toThrow('OS keychain is not available; cannot persist SSH password');
  });

  it('passes vault references through without encryption', () => {
    expect(encryptConfigPassword({ password: 'vault://secret/ssh#password' }))
      .toEqual({ password: 'vault://secret/ssh#password' });
  });

  it('rejects encrypted password reads without an OS keychain', () => {
    expect(() => decryptConfigPassword({ password: 'base64blob', passwordEncrypted: true }))
      .toThrow('OS keychain is not available; cannot read SSH password');
  });
});
