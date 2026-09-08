import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ net: { fetch: fetchMock } }));
import { VaultClient } from './vault-client';

beforeEach(() => { fetchMock.mockReset(); });

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
