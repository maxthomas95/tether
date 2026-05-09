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
const VALID_REF = 'vault://secret/foo#bar';

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

function useFakeClient(overrides: Partial<FakeClient> = {}): void {
  mockedBuildClient.mockReturnValue(fakeClient(overrides) as never);
}

function useKvData(data: Record<string, unknown>): void {
  useFakeClient({ kvRead: async () => ({ data }) });
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

    it.each([undefined, null, 42, {}])('returns false for non-string value %j', (value) => {
      expect(isVaultRef(value)).toBe(false);
    });
  });

  describe('parseRef', () => {
    it.each([
      [
        'simple ref',
        'vault://secret/api-keys#ANTHROPIC_API_KEY',
        { mount: 'secret', path: 'api-keys', key: 'ANTHROPIC_API_KEY' },
      ],
      [
        'multi-segment path',
        'vault://secret/tether/ssh/prod#password',
        { mount: 'secret', path: 'tether/ssh/prod', key: 'password' },
      ],
    ])('parses a %s', (_label, ref, expected) => {
      expect(parseRef(ref)).toEqual(expected);
    });

    it.each([
      ['non-vault-ref input', 'not-a-ref'],
      ['missing #', 'vault://secret/foo'],
      ['empty key', 'vault://secret/foo#'],
      ['empty mount', 'vault:///foo#key'],
      ['empty path', 'vault://secret/#key'],
      ['missing slash between mount and path', 'vault://secret#key'],
    ])('returns null for %s', (_label, ref) => {
      expect(parseRef(ref)).toBeNull();
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
      useKvData({ ANTHROPIC_API_KEY: 'sk-ant-test' });

      await expect(resolveRef('vault://secret/api-keys#ANTHROPIC_API_KEY')).resolves.toBe('sk-ant-test');
    });

    it('throws VaultError on a malformed ref', async () => {
      useFakeClient();
      await expect(resolveRef('vault://broken')).rejects.toBeInstanceOf(VaultError);
    });

    it('throws when Vault integration is not enabled (buildClient returns null)', async () => {
      mockedBuildClient.mockReturnValue(null);
      await expect(resolveRef(VALID_REF)).rejects.toThrow(/not enabled/);
    });

    it('throws when client has no token', async () => {
      useFakeClient({ hasToken: () => false });
      await expect(resolveRef(VALID_REF)).rejects.toThrow(/Not logged in/);
    });

    it.each([
      ['missing the requested key', { other: 'value' }, 'vault://secret/foo#missing', /no field "missing"/],
      ['not a string', { count: 42 }, 'vault://secret/foo#count', /is not a string/],
      ['null', { key: null }, 'vault://secret/foo#key', /no field "key"/],
    ])('throws when the secret value is %s', async (_label, data, ref, expectedError) => {
      useKvData(data);
      await expect(resolveRef(ref)).rejects.toThrow(expectedError);
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
      useFakeClient({
        kvRead: async (_mount, path) => ({
          data: path === 'a' ? { k: 'value-a' } : { k: 'value-b' },
        }),
      });

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
      useFakeClient({
        kvRead: async (_mount, path) => {
          callOrder.push(`start:${path}`);
          await new Promise((r) => setTimeout(r, 0));
          callOrder.push(`end:${path}`);
          return { data: { k: path } };
        },
      });

      await resolveAll({
        A: 'vault://secret/a#k',
        B: 'vault://secret/b#k',
      });

      // Both should start before either ends — proves they run concurrently.
      expect(callOrder.slice(0, 2)).toEqual(['start:a', 'start:b']);
    });

    it('rejects the whole batch when any ref fails', async () => {
      useFakeClient({
        kvRead: async (_mount, path) => {
          if (path === 'bad') throw new VaultError('not found', 404);
          return { data: { k: 'ok' } };
        },
      });

      await expect(
        resolveAll({
          GOOD: 'vault://secret/good#k',
          BAD: 'vault://secret/bad#k',
        }),
      ).rejects.toBeInstanceOf(VaultError);
    });
  });
});
