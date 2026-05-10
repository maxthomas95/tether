import { describe, it, expect, beforeEach, vi } from 'vitest';

const registry = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  listeners: new Map<string, (event: unknown, ...args: unknown[]) => void>(),
}));

const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => false),
  encryptString: vi.fn(),
  decryptString: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (event: unknown, ...args: unknown[]) => unknown) => { registry.handlers.set(ch, fn); },
    on: (ch: string, fn: (event: unknown, ...args: unknown[]) => void) => { registry.listeners.set(ch, fn); },
  },
  safeStorage: safeStorageMock,
}));

const vaultAuthMock = vi.hoisted(() => ({
  getVaultConfig: vi.fn(),
  setVaultConfig: vi.fn(),
  loginOidc: vi.fn(),
  cancelLoginOidc: vi.fn(),
  logoutVault: vi.fn(),
  getStatus: vi.fn(),
  buildClient: vi.fn(),
  DEFAULT_VAULT_CONFIG: { enabled: false, addr: '', role: '', mount: 'secret', namespace: '' },
  setExpiryWarningCallback: vi.fn(),
}));
vi.mock('../vault/vault-auth', () => vaultAuthMock);

const vaultResolverMock = vi.hoisted(() => ({
  isVaultRef: vi.fn((v: unknown) => typeof v === 'string' && v.startsWith('vault://')),
  resolveRef: vi.fn(),
  parseRef: vi.fn((ref: string) => {
    const m = /^vault:\/\/([^/]+)\/(.+)#(.+)$/.exec(ref);
    return m ? { mount: m[1], path: m[2], key: m[3] } : null;
  }),
  buildRef: vi.fn((mount: string, path: string, key: string) => `vault://${mount}/${path}#${key}`),
}));
vi.mock('../vault/vault-resolver', () => vaultResolverMock);

const dbState = vi.hoisted(() => ({
  environments: [] as Array<{ id: string; name: string; type: string; config: string; env_vars: string; updated_at: string }>,
  gitProviders: [] as Array<{ id: string; name: string; token: string; updated_at: string }>,
  defaultEnvVars: {} as Record<string, string>,
  saveCount: 0,
}));
vi.mock('../db/database', () => ({
  getDb: () => dbState,
  saveDb: () => { dbState.saveCount += 1; },
}));

import { IPC } from '../../shared/constants';
import { registerVaultHandlers } from './vault-handlers';
import { createHarness } from './ipc-test-harness.test-helper';

const harness = createHarness(registry);

const fakeClient = (overrides: Record<string, unknown> = {}) => ({
  hasToken: () => true,
  kvList: vi.fn().mockResolvedValue([]),
  kvRead: vi.fn().mockResolvedValue({ data: {} }),
  kvWrite: vi.fn().mockResolvedValue(undefined),
  ...overrides,
});

function resetDb() {
  dbState.environments = [];
  dbState.gitProviders = [];
  dbState.defaultEnvVars = {};
  dbState.saveCount = 0;
}

describe('vault-handlers', () => {
  beforeEach(() => {
    harness.reset();
    Object.values(vaultAuthMock).forEach((m) => 'mockReset' in (m as object) && (m as ReturnType<typeof vi.fn>).mockReset());
    Object.values(vaultResolverMock).forEach((m) => 'mockClear' in (m as object) && (m as ReturnType<typeof vi.fn>).mockClear());
    Object.values(safeStorageMock).forEach((m) => m.mockReset());
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    resetDb();
    registerVaultHandlers(harness.ctx);
  });

  describe('config / auth', () => {
    it('VAULT_GET_CONFIG returns DEFAULT_VAULT_CONFIG when nothing is saved', async () => {
      vaultAuthMock.getVaultConfig.mockReturnValue({ enabled: false, addr: '', role: '', mount: 'secret', namespace: '' });
      const result = await harness.invoke(IPC.VAULT_GET_CONFIG);
      expect(result).toEqual(vaultAuthMock.DEFAULT_VAULT_CONFIG);
    });

    it('VAULT_GET_CONFIG returns saved config when populated', async () => {
      const cfg = { enabled: true, addr: 'https://vault', role: 'r', mount: 'secret', namespace: '' };
      vaultAuthMock.getVaultConfig.mockReturnValue(cfg);
      expect(await harness.invoke(IPC.VAULT_GET_CONFIG)).toEqual(cfg);
    });

    it('VAULT_SET_CONFIG persists and pushes status', async () => {
      vaultAuthMock.getStatus.mockReturnValue({ enabled: true, loggedIn: false });
      const cfg = { enabled: true, addr: 'https://vault', role: 'r', mount: 'secret', namespace: '' };
      await harness.invoke(IPC.VAULT_SET_CONFIG, cfg);
      expect(vaultAuthMock.setVaultConfig).toHaveBeenCalledWith(cfg);
      expect(harness.send).toHaveBeenCalledWith(IPC.VAULT_STATUS_CHANGED, { enabled: true, loggedIn: false });
    });

    it('VAULT_LOGIN runs OIDC + emits status', async () => {
      vaultAuthMock.loginOidc.mockResolvedValue({ enabled: true, loggedIn: true, identity: 'me' });
      const result = await harness.invoke(IPC.VAULT_LOGIN);
      expect(harness.send).toHaveBeenCalledWith(IPC.VAULT_STATUS_CHANGED, expect.objectContaining({ loggedIn: true }));
      expect(result).toEqual({ enabled: true, loggedIn: true, identity: 'me' });
    });

    it('VAULT_CANCEL_LOGIN delegates to cancelLoginOidc', async () => {
      await harness.invoke(IPC.VAULT_CANCEL_LOGIN);
      expect(vaultAuthMock.cancelLoginOidc).toHaveBeenCalled();
    });

    it('VAULT_LOGOUT clears + emits status', async () => {
      vaultAuthMock.getStatus.mockReturnValue({ enabled: true, loggedIn: false });
      await harness.invoke(IPC.VAULT_LOGOUT);
      expect(vaultAuthMock.logoutVault).toHaveBeenCalled();
      expect(harness.send).toHaveBeenCalledWith(IPC.VAULT_STATUS_CHANGED, expect.objectContaining({ loggedIn: false }));
    });

    it('VAULT_STATUS returns current status', async () => {
      vaultAuthMock.getStatus.mockReturnValue({ enabled: true, loggedIn: true });
      expect(await harness.invoke(IPC.VAULT_STATUS)).toEqual({ enabled: true, loggedIn: true });
    });

    it('expiry-warning callback is wired and sends VAULT_EXPIRY_WARNING', () => {
      expect(vaultAuthMock.setExpiryWarningCallback).toHaveBeenCalledTimes(1);
      const cb = vaultAuthMock.setExpiryWarningCallback.mock.calls[0][0] as (expiresAt: number) => void;
      cb(1234);
      expect(harness.send).toHaveBeenCalledWith(IPC.VAULT_EXPIRY_WARNING, { expiresAt: 1234 });
    });
  });

  describe('VAULT_TEST_REF', () => {
    it('returns ok:true on resolve success', async () => {
      vaultResolverMock.resolveRef.mockResolvedValue('value');
      const result = await harness.invoke(IPC.VAULT_TEST_REF, 'vault://secret/x#k');
      expect(result).toEqual({ ok: true });
    });

    it('returns ok:false with error on resolve failure', async () => {
      vaultResolverMock.resolveRef.mockRejectedValue(new Error('not found'));
      const result = await harness.invoke(IPC.VAULT_TEST_REF, 'vault://secret/x#k');
      expect(result).toEqual({ ok: false, error: 'not found' });
    });
  });

  describe('VAULT_LIST_KEYS / LIST_FIELDS / WRITE_SECRET', () => {
    it('throws when vault is not enabled', async () => {
      vaultAuthMock.buildClient.mockReturnValue(null);
      await expect(harness.invoke(IPC.VAULT_LIST_KEYS, 'secret', 'p')).rejects.toThrow(/not enabled/);
      await expect(harness.invoke(IPC.VAULT_LIST_FIELDS, 'secret', 'p')).rejects.toThrow(/not enabled/);
      await expect(harness.invoke(IPC.VAULT_WRITE_SECRET, 'vault://secret/p#k', 'v')).rejects.toThrow(/not enabled/);
    });

    it('throws when client has no token', async () => {
      vaultAuthMock.buildClient.mockReturnValue(fakeClient({ hasToken: () => false }));
      await expect(harness.invoke(IPC.VAULT_LIST_KEYS, 'secret', 'p')).rejects.toThrow(/Not logged in/);
    });

    it('LIST_KEYS delegates to client.kvList', async () => {
      const client = fakeClient({ kvList: vi.fn().mockResolvedValue(['a', 'b']) });
      vaultAuthMock.buildClient.mockReturnValue(client);
      const result = await harness.invoke(IPC.VAULT_LIST_KEYS, 'secret', 'p');
      expect(client.kvList).toHaveBeenCalledWith('secret', 'p');
      expect(result).toEqual(['a', 'b']);
    });

    it('LIST_FIELDS returns Object.keys of the secret data (no values)', async () => {
      const client = fakeClient({ kvRead: vi.fn().mockResolvedValue({ data: { foo: 'secret-1', bar: 'secret-2' } }) });
      vaultAuthMock.buildClient.mockReturnValue(client);
      const result = await harness.invoke(IPC.VAULT_LIST_FIELDS, 'secret', 'p');
      expect(result).toEqual(['foo', 'bar']);
    });

    it('WRITE_SECRET parses ref and writes the single field', async () => {
      const client = fakeClient();
      vaultAuthMock.buildClient.mockReturnValue(client);
      await harness.invoke(IPC.VAULT_WRITE_SECRET, 'vault://secret/p#k', 'value');
      expect(client.kvWrite).toHaveBeenCalledWith('secret', 'p', { k: 'value' });
    });

    it('WRITE_SECRET throws on malformed ref', async () => {
      vaultAuthMock.buildClient.mockReturnValue(fakeClient());
      await expect(harness.invoke(IPC.VAULT_WRITE_SECRET, 'not-a-ref', 'v')).rejects.toThrow(/Malformed/);
    });
  });

  describe('VAULT_LIST_PLAINTEXT', () => {
    it('flags SSH passwords on environments + git provider tokens + sensitive env vars', async () => {
      dbState.environments = [
        { id: 'e1', name: 'Prod', type: 'ssh', config: JSON.stringify({ password: 'plaintext' }), env_vars: '{}', updated_at: '' },
        { id: 'e2', name: 'Local', type: 'local', config: JSON.stringify({ password: 'vault://secret/x#k' }), env_vars: JSON.stringify({ ANTHROPIC_API_KEY: 'sk-real', NORMAL: 'value' }), updated_at: '' },
      ];
      dbState.gitProviders = [
        { id: 'gp-1', name: 'GH', token: 'ghp_real', updated_at: '' },
        { id: 'gp-2', name: 'GHV', token: 'vault://secret/g#tok', updated_at: '' },
      ];
      dbState.defaultEnvVars = { OPENAI_API_KEY: 'sk-real', PLAIN: 'v', VAULTED: 'vault://secret/k#v' };

      const result = await harness.invoke<Array<{ source: string; key?: string }>>(IPC.VAULT_LIST_PLAINTEXT);
      const sources = result.map(r => `${r.source}:${r.key || ''}`).sort((a, b) => a.localeCompare(b));
      // Only plaintext sensitive things should appear; vault refs should not
      expect(sources).toContain('sshPassword:');
      expect(sources).toContain('gitProvider:');
      expect(sources).toContain('envVar:OPENAI_API_KEY');
      expect(sources).toContain('envEnvVar:ANTHROPIC_API_KEY');
      expect(sources.find(s => s.includes('PLAIN'))).toBeUndefined();
      expect(sources.find(s => s.includes('VAULTED'))).toBeUndefined();
    });
  });

  describe('VAULT_MIGRATE_SECRET', () => {
    it('writes secret to vault and rewrites env_vars with the ref', async () => {
      dbState.environments = [{
        id: 'e1', name: 'Local', type: 'local',
        config: '{}',
        env_vars: JSON.stringify({ ANTHROPIC_API_KEY: 'sk-real' }),
        updated_at: '',
      }];
      const client = fakeClient({
        kvRead: vi.fn().mockRejectedValue(new Error('404 secret not found')),
        kvWrite: vi.fn().mockResolvedValue(undefined),
      });
      vaultAuthMock.buildClient.mockReturnValue(client);

      await harness.invoke(IPC.VAULT_MIGRATE_SECRET, {
        source: 'envEnvVar',
        sourceId: 'e1',
        key: 'ANTHROPIC_API_KEY',
        targetRef: 'vault://secret/api-keys#ANTHROPIC_API_KEY',
      });

      expect(client.kvWrite).toHaveBeenCalledWith('secret', 'api-keys', { ANTHROPIC_API_KEY: 'sk-real' });
      const env = JSON.parse(dbState.environments[0].env_vars);
      expect(env.ANTHROPIC_API_KEY).toBe('vault://secret/api-keys#ANTHROPIC_API_KEY');
      expect(dbState.saveCount).toBe(1);
    });

    it('throws when target ref is malformed', async () => {
      vaultAuthMock.buildClient.mockReturnValue(fakeClient());
      await expect(harness.invoke(IPC.VAULT_MIGRATE_SECRET, {
        source: 'gitProvider',
        sourceId: 'gp-1',
        targetRef: 'broken',
      })).rejects.toThrow(/Malformed target/);
    });
  });
});
