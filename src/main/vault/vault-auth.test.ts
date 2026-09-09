import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: {} as Record<string, string>,
  save: vi.fn(),
  encryptionAvailable: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
  open: vi.fn(),
  authUrl: vi.fn(),
  exchange: vi.fn(),
  lookup: vi.fn(),
  setToken: vi.fn(),
  close: vi.fn(),
  listen: vi.fn(),
  bindError: undefined as Error | undefined,
  request: undefined as ((req: { url?: string }, res: unknown) => void) | undefined,
}));

vi.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable: mocks.encryptionAvailable, encryptString: mocks.encrypt, decryptString: mocks.decrypt },
  shell: { openExternal: mocks.open },
}));
vi.mock('../db/database', () => ({ getDb: () => ({ config: mocks.config }), saveDb: mocks.save }));
vi.mock('./vault-client', () => ({
  VaultClient: class {
    oidcAuthUrl = mocks.authUrl;
    oidcCallback = mocks.exchange;
    lookupSelf = mocks.lookup;
    setToken = mocks.setToken;
  },
}));
vi.mock('node:http', () => ({ default: {
  createServer: (handler: typeof mocks.request) => {
    mocks.request = handler;
    let onError: (error: Error) => void;
    return {
      on: (_event: string, callback: typeof onError) => { onError = callback; },
      close: mocks.close,
      address: () => ({ port: 8250 }),
      listen: (port: number, host: string, ready: () => void) => {
        mocks.listen(port, host);
        if (mocks.bindError) onError(mocks.bindError);
        else ready();
      },
    };
  },
} }));

import { cancelLoginOidc, clearCachedToken, getCachedToken, getStatus, loginOidc, setCachedToken, setExpiryWarningCallback } from './vault-auth';

function callback(url: string) {
  const response = { writeHead: vi.fn().mockReturnThis(), end: vi.fn().mockReturnThis() };
  mocks.request?.({ url }, response);
  return response;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-08T12:00:00Z'));
  vi.clearAllMocks();
  mocks.config = { vaultEnabled: 'true', vaultAddr: 'https://vault.example.test', vaultRole: 'developer' };
  mocks.bindError = undefined;
  mocks.encryptionAvailable.mockReturnValue(true);
  mocks.encrypt.mockReturnValue(Buffer.from('encrypted-fixture'));
  mocks.decrypt.mockReturnValue('fixture-token');
  mocks.authUrl.mockResolvedValue({ auth_url: 'https://identity.example.test/login' });
  mocks.open.mockResolvedValue(undefined);
  mocks.exchange.mockResolvedValue({ client_token: 'fixture-token', ttl_seconds: 3600, identity: 'callback identity' });
  mocks.lookup.mockResolvedValue({ identity: 'friendly identity', expiresAt: '2026-09-08T14:00:00Z' });
});

afterEach(() => {
  clearCachedToken();
  vi.useRealTimers();
});

describe('Vault OIDC lifecycle', () => {
  it('binds only to loopback and persists the successful login through safeStorage', async () => {
    const login = loginOidc();
    await vi.waitFor(() => expect(mocks.open).toHaveBeenCalled());
    expect(mocks.listen).toHaveBeenCalledExactlyOnceWith(8250, '127.0.0.1');
    expect(mocks.authUrl).toHaveBeenCalledWith('developer', 'http://localhost:8250/oidc/callback');
    expect(callback('/favicon.ico').writeHead).toHaveBeenCalledWith(404);
    expect(mocks.exchange).not.toHaveBeenCalled();
    callback('/oidc/callback?state=fixture-state&code=fixture-code&id_token=fixture-id');
    expect(await login).toEqual({ enabled: true, loggedIn: true, expiresAt: '2026-09-08T14:00:00Z', identity: 'friendly identity' });
    expect(mocks.exchange).toHaveBeenCalledWith('fixture-state', 'fixture-code', 'fixture-id');
    expect(mocks.encrypt).toHaveBeenCalledExactlyOnceWith('fixture-token');
    expect(mocks.config.vaultToken).toBe(Buffer.from('encrypted-fixture').toString('base64'));
    expect(mocks.close).toHaveBeenCalled();
  });

  it('cancels a waiting callback without caching a token', async () => {
    const rejected = expect(loginOidc()).rejects.toThrow('Vault login cancelled');
    await vi.waitFor(() => expect(mocks.open).toHaveBeenCalled());
    cancelLoginOidc();
    await rejected;
    expect(mocks.close).toHaveBeenCalled();
    expect(mocks.encrypt).not.toHaveBeenCalled();
    expect(mocks.exchange).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects incomplete callbacks and closes the listener', async () => {
    const rejected = expect(loginOidc()).rejects.toThrow('missing state or code');
    await vi.waitFor(() => expect(mocks.open).toHaveBeenCalled());
    expect(callback('/oidc/callback?state=fixture-state').writeHead).toHaveBeenCalledWith(400);
    await rejected;
    expect(mocks.encrypt).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out and releases the callback listener', async () => {
    const rejected = expect(loginOidc()).rejects.toThrow('timed out after 5 minutes');
    await vi.waitFor(() => expect(mocks.open).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(300_000);
    await rejected;
    expect(mocks.close).toHaveBeenCalled();
    expect(mocks.encrypt).not.toHaveBeenCalled();
  });

  it('does not retain the five-minute timer when the callback port cannot bind', async () => {
    mocks.bindError = new Error('address already in use');
    await expect(loginOidc()).rejects.toThrow('Failed to start OIDC callback server');
    expect(mocks.open).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['file:///unexpected', 'javascript:void(0)'])('rejects an unsafe browser URL %s', async authUrl => {
    mocks.authUrl.mockResolvedValue({ auth_url: authUrl });
    await expect(loginOidc()).rejects.toThrow('Refusing to open auth_url');
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up after browser launch failure', async () => {
    mocks.open.mockRejectedValue(new Error('browser unavailable'));
    await expect(loginOidc()).rejects.toThrow('browser unavailable');
    expect(mocks.close).toHaveBeenCalled();
    expect(mocks.encrypt).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the valid callback identity if lookup-self is unavailable', async () => {
    mocks.lookup.mockRejectedValue(new Error('lookup denied'));
    const login = loginOidc();
    await vi.waitFor(() => expect(mocks.open).toHaveBeenCalled());
    const expectedExpiry = new Date(Date.now() + 3600_000).toISOString();
    callback('/oidc/callback?state=fixture-state&code=fixture-code');
    expect(await login).toMatchObject({ loggedIn: true, identity: 'callback identity', expiresAt: expectedExpiry });
  });
});

describe('Vault token storage and expiry', () => {
  it('refuses plaintext fallback when encryption is unavailable', () => {
    mocks.encryptionAvailable.mockReturnValue(false);
    expect(() => setCachedToken('fixture-token')).toThrow('cannot cache Vault token');
    expect(mocks.config.vaultToken).toBeUndefined();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('treats unreadable and expired cached tokens as logged out', () => {
    setCachedToken('fixture-token', '2026-09-08T11:59:00Z');
    expect(getStatus()).toMatchObject({ loggedIn: false });
    mocks.decrypt.mockImplementation(() => { throw new Error('unreadable'); });
    expect(getCachedToken()).toBeNull();
    expect(getStatus()).toEqual({ enabled: true, loggedIn: false });
  });

  it('replaces expiry warnings on renewal and cancels them on logout', async () => {
    const warn = vi.fn();
    setExpiryWarningCallback(warn);
    setCachedToken('fixture-token', '2026-09-08T13:00:00Z');
    setCachedToken('renewed-fixture', '2026-09-08T14:00:00Z');
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(warn).toHaveBeenCalledExactlyOnceWith('2026-09-08T14:00:00Z');
    setCachedToken('another-fixture', '2026-09-08T15:00:00Z');
    clearCachedToken();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(warn).toHaveBeenCalledOnce();
    expect(getStatus()).toEqual({ enabled: true, loggedIn: false });
  });
});
