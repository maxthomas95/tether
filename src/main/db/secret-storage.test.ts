import { describe, expect, it, beforeEach, vi } from 'vitest';

const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(),
  encryptString: vi.fn((value: string) => Buffer.from(`enc:${value}`)),
  decryptString: vi.fn((value: Buffer) => value.toString('utf8').replace(/^enc:/, '')),
}));

vi.mock('electron', () => ({ safeStorage: safeStorageMock }));

import {
  decryptEnvVarsRecord,
  decryptSecretFromStorage,
  encryptEnvVarsRecord,
  encryptSecretForStorage,
  isEncryptedSecret,
  looksSensitiveEnvKey,
} from './secret-storage';

describe('secret-storage', () => {
  beforeEach(() => {
    safeStorageMock.isEncryptionAvailable.mockReset();
    safeStorageMock.encryptString.mockClear();
    safeStorageMock.decryptString.mockClear();
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
  });

  it('encrypts and decrypts ordinary secrets', () => {
    const stored = encryptSecretForStorage('plain-token', 'token');
    expect(isEncryptedSecret(stored)).toBe(true);
    expect(stored).not.toContain('plain-token');
    expect(decryptSecretFromStorage(stored, 'token')).toBe('plain-token');
  });

  it('leaves Vault refs unchanged', () => {
    expect(encryptSecretForStorage('vault://secret/git#token', 'token')).toBe('vault://secret/git#token');
  });

  it('refuses to encrypt new secrets without safeStorage', () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    expect(() => encryptSecretForStorage('plain-token', 'token')).toThrow(/OS keychain/);
  });

  it('encrypts only sensitive environment keys', () => {
    expect(looksSensitiveEnvKey('ANTHROPIC_API_KEY')).toBe(true);
    expect(looksSensitiveEnvKey('NODE_ENV')).toBe(false);

    const stored = encryptEnvVarsRecord({
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      NODE_ENV: 'development',
    });
    expect(isEncryptedSecret(stored.ANTHROPIC_API_KEY)).toBe(true);
    expect(stored.NODE_ENV).toBe('development');
    expect(decryptEnvVarsRecord(stored)).toEqual({
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      NODE_ENV: 'development',
    });
  });
});

