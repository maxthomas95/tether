import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ net: { fetch: fetchMock } }));
import { VaultClient, normalizeVaultAddr } from './vault-client';

beforeEach(() => { fetchMock.mockReset(); });

describe('Vault credential destination', () => {
  it.each(['http://vault.example.test', 'https://user:password@vault.example.test', 'https://vault.example.test/path', 'https://vault.example.test?token=x', 'file:///vault'])('refuses unsafe address %s', addr => {
    expect(() => normalizeVaultAddr(addr)).toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(['http://localhost:8200', 'http://127.0.0.1:8200', 'http://[::1]:8200', 'https://vault.example.test'])('allows explicit TLS or loopback origin %s', addr => {
    expect(normalizeVaultAddr(addr)).toBe(addr);
  });
  it('blocks redirects even when the response mock ignores fetch redirect policy', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 307, headers: { Location: 'https://other.example.test' } }));
    await expect(new VaultClient({ addr: 'https://vault.example.test', token: 'fixture-secret' }).lookupSelf()).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'error', headers: { 'X-Vault-Token': 'fixture-secret' } });
  });
});

describe('Vault request path normalization', () => {
  const makeClient = () => new VaultClient({ addr: 'https://vault.example.test///', token: 'test-token' });

  it('reads a secret with edge slashes removed and interior slashes preserved', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { data: { region: 'west' } } })));
    const result = await makeClient().kvRead('///secret///', '///team//service///');
    expect(fetchMock).toHaveBeenCalledWith('https://vault.example.test/v1/secret/data/team//service', expect.objectContaining({ method: 'GET' }));
    expect(result.data).toEqual({ region: 'west' });
  });

  it('writes a secret with the same path normalization and KV v2 envelope', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await makeClient().kvWrite('///secret///', '///team//service///', { region: 'west' });
    expect(fetchMock).toHaveBeenCalledWith('https://vault.example.test/v1/secret/data/team//service', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ data: { region: 'west' } }),
    }));
  });

  it('lists the mount root when the path contains only slashes', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { keys: ['team/'] } })));
    expect(await makeClient().kvList('/secret/', '////')).toEqual(['team/']);
    expect(fetchMock).toHaveBeenCalledWith('https://vault.example.test/v1/secret/metadata/', expect.objectContaining({ method: 'LIST' }));
  });

  it('preserves long interior slash runs in mounts and paths', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { keys: [] } })));
    const interior = 'team' + '/'.repeat(100_000) + 'service';
    await makeClient().kvList('/' + interior + '/', '/' + interior + '/');
    expect(fetchMock).toHaveBeenCalledWith(`https://vault.example.test/v1/${interior}/metadata/${interior}`, expect.objectContaining({ method: 'LIST' }));
  });
});
