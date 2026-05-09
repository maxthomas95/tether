import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./vault-auth', () => ({
  buildClient: vi.fn(),
}));

import { buildClient } from './vault-auth';
import {
  isVaultRef,
  parseRef,
  buildRef,
  resolveRef,
  resolveAll,
  VAULT_REF_PREFIX,
} from './vault-resolver';
import { VaultError } from './vault-types';

const mockedBuildClient = vi.mocked(buildClient);

interface FakeClient {
  hasToken: () => boolean;
  kvRead: (mount: string, path: string) => Promise<{ data: Record<string, unknown> }>;
}

function fakeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  return {
    hasToken: () => true,
    kvRead: async () => ({ data: {} }),
    ...overrides,
  };
}

describe('vault-resolver', () => {
  beforeEach(() => {
    mockedBuildClient.mockReset();
  });

  describe('isVaultRef', () => {
    it('returns true for vault:// strings', () => {
      expect(isVaultRef('vault://secret/foo#bar')).toBe(true);
    });

    it('returns false for plain strings', () => {
      expect(isVaultRef('plaintext-value')).toBe(false);
    });

    it('returns false for non-strings', () => {
      expect(isVaultRef(undefined)).toBe(false);
      expect(isVaultRef(null)).toBe(false);
      expect(isVaultRef(42)).toBe(false);
      expect(isVaultRef({})).toBe(false);
    });
  });

  describe('parseRef', () => {
    it('parses a simple ref', () => {
      expect(parseRef('vault://secret/api-keys#ANTHROPIC_API_KEY')).toEqual({
        mount: 'secret',
        path: 'api-keys',
        key: 'ANTHROPIC_API_KEY',
      });
    });

    it('parses a ref with a multi-segment path', () => {
      expect(parseRef('vault://secret/tether/ssh/prod#password')).toEqual({
        mount: 'secret',
        path: 'tether/ssh/prod',
        key: 'password',
      });
    });

    it('returns null for non-vault-ref input', () => {
      expect(parseRef('not-a-ref')).toBeNull();
    });

    it('returns null when # is missing', () => {
      expect(parseRef('vault://secret/foo')).toBeNull();
    });

    it('returns null when the key is empty', () => {
      expect(parseRef('vault://secret/foo#')).toBeNull();
    });

    it('returns null when the mount is empty', () => {
      expect(parseRef('vault:///foo#key')).toBeNull();
    });

    it('returns null when the path is empty', () => {
      expect(parseRef('vault://secret/#key')).toBeNull();
    });

    it('returns null when there is no slash between mount and path', () => {
      expect(parseRef('vault://secret#key')).toBeNull();
    });
  });

  describe('buildRef', () => {
    it('round-trips with parseRef', () => {
      const ref = buildRef('secret', 'tether/ssh/prod', 'password');
      expect(ref).toBe(`${VAULT_REF_PREFIX}secret/tether/ssh/prod#password`);
      expect(parseRef(ref)).toEqual({ mount: 'secret', path: 'tether/ssh/prod', key: 'password' });
    });
  });

  describe('resolveRef', () => {
    it('returns the secret value on the happy path', async () => {
      mockedBuildClient.mockReturnValue(fakeClient({
        kvRead: async () => ({ data: { ANTHROPIC_API_KEY: 'sk-ant-test' } }),
      }) as never);

      await expect(resolveRef('vault://secret/api-keys#ANTHROPIC_API_KEY')).resolves.toBe('sk-ant-test');
    });

    it('throws VaultError on a malformed ref', async () => {
      mockedBuildClient.mockReturnValue(fakeClient() as never);
      await expect(resolveRef('vault://broken')).rejects.toBeInstanceOf(VaultError);
    });

    it('throws when Vault integration is not enabled (buildClient returns null)', async () => {
      mockedBuildClient.mockReturnValue(null);
      await expect(resolveRef('vault://secret/foo#bar')).rejects.toThrow(/not enabled/);
    });

    it('throws when client has no token', async () => {
      mockedBuildClient.mockReturnValue(fakeClient({ hasToken: () => false }) as never);
      await expect(resolveRef('vault://secret/foo#bar')).rejects.toThrow(/Not logged in/);
    });

    it('throws when the secret is missing the requested key', async () => {
      mockedBuildClient.mockReturnValue(fakeClient({
        kvRead: async () => ({ data: { other: 'value' } }),
      }) as never);

      await expect(resolveRef('vault://secret/foo#missing')).rejects.toThrow(/no field "missing"/);
    });

    it('throws when the value is not a string', async () => {
      mockedBuildClient.mockReturnValue(fakeClient({
        kvRead: async () => ({ data: { count: 42 } }),
      }) as never);

      await expect(resolveRef('vault://secret/foo#count')).rejects.toThrow(/is not a string/);
    });

    it('throws when the value is null (treated as missing)', async () => {
      mockedBuildClient.mockReturnValue(fakeClient({
        kvRead: async () => ({ data: { key: null } }),
      }) as never);

      await expect(resolveRef('vault://secret/foo#key')).rejects.toThrow(/no field "key"/);
    });
  });

  describe('resolveAll', () => {
    it('returns an empty object for empty input', async () => {
      await expect(resolveAll({})).resolves.toEqual({});
      expect(mockedBuildClient).not.toHaveBeenCalled();
    });

    it('passes through non-ref values without calling Vault', async () => {
      const input = { FOO: 'bar', BAZ: 'qux' };
      await expect(resolveAll(input)).resolves.toEqual(input);
      expect(mockedBuildClient).not.toHaveBeenCalled();
    });

    it('resolves a mix of refs and plain values', async () => {
      mockedBuildClient.mockReturnValue(fakeClient({
        kvRead: async (_mount, path) => ({
          data: path === 'a' ? { k: 'value-a' } : { k: 'value-b' },
        }),
      }) as never);

      const result = await resolveAll({
        PLAIN: 'literal',
        SECRET_A: 'vault://secret/a#k',
        SECRET_B: 'vault://secret/b#k',
      });

      expect(result).toEqual({
        PLAIN: 'literal',
        SECRET_A: 'value-a',
        SECRET_B: 'value-b',
      });
    });

    it('resolves multiple refs in parallel', async () => {
      const callOrder: string[] = [];
      mockedBuildClient.mockReturnValue(fakeClient({
        kvRead: async (_mount, path) => {
          callOrder.push(`start:${path}`);
          await new Promise((r) => setTimeout(r, 0));
          callOrder.push(`end:${path}`);
          return { data: { k: path } };
        },
      }) as never);

      await resolveAll({
        A: 'vault://secret/a#k',
        B: 'vault://secret/b#k',
      });

      // Both should start before either ends — proves they run concurrently.
      expect(callOrder.slice(0, 2)).toEqual(['start:a', 'start:b']);
    });

    it('rejects the whole batch when any ref fails', async () => {
      mockedBuildClient.mockReturnValue(fakeClient({
        kvRead: async (_mount, path) => {
          if (path === 'bad') throw new VaultError('not found', 404);
          return { data: { k: 'ok' } };
        },
      }) as never);

      await expect(
        resolveAll({
          GOOD: 'vault://secret/good#k',
          BAD: 'vault://secret/bad#k',
        }),
      ).rejects.toBeInstanceOf(VaultError);
    });
  });
});
