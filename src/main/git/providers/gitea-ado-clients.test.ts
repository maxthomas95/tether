import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdoClient } from './ado-client';
import { GiteaClient } from './gitea-client';

let fetchMock: ReturnType<typeof vi.fn>;
const originalFetch = globalThis.fetch;

function reply(body: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
}

function request(index = 0): { url: URL; init: RequestInit & { headers: Record<string, string> } } {
  const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit & { headers: Record<string, string> }];
  return { url: new URL(url), init };
}

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('GiteaClient', () => {
  const giteaRepo = { full_name: 'max/tether', clone_url: 'https://git.example.com/max/tether.git', description: null, default_branch: null, private: true };
  const client = () => new GiteaClient('https://git.example.com/', 'secret-token');

  it('authenticates the connection test against the user endpoint', async () => {
    reply({ id: 1, login: 'max' });

    await client().testConnection();

    const { url, init } = request();
    expect(url.href).toBe('https://git.example.com/api/v1/user');
    expect(init.headers.Authorization).toBe('token secret-token');
    expect(init.redirect).toBe('error');
  });

  it("lists the user's own repositories when there is no query", async () => {
    reply([giteaRepo]);

    const repos = await client().listRepos('   ');

    expect(request().url.pathname).toBe('/api/v1/user/repos');
    expect(request().url.searchParams.get('limit')).toBe('50');
    expect(repos).toEqual([{
      fullName: 'max/tether', cloneUrl: giteaRepo.clone_url, description: '', defaultBranch: 'main', isPrivate: true,
    }]);
  });

  it('searches by query, newest first, and accepts the wrapped response shape', async () => {
    reply({ ok: true, data: [{ ...giteaRepo, description: 'Session multiplexer', default_branch: 'trunk' }] });

    const repos = await client().listRepos(' tether ', 2, 10);

    const { url } = request();
    expect(url.pathname).toBe('/api/v1/repos/search');
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: 'tether', page: '2', limit: '10', sort: 'updated', order: 'desc' });
    expect(repos[0]).toMatchObject({ description: 'Session multiplexer', defaultBranch: 'trunk' });
  });

  it.each([[{ ok: true }], [{ data: 'none' }], [null]])('returns no repositories for an unrecognized response %j', async body => {
    reply(body);
    expect(await client().listRepos()).toEqual([]);
  });

  it('creates an empty repository with the requested visibility', async () => {
    reply(giteaRepo);

    const created = await client().createRepo({ name: 'tether', isPrivate: true });

    const { url, init } = request();
    expect(url.pathname).toBe('/api/v1/user/repos');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'tether', description: '', private: true, auto_init: false });
    expect(created.fullName).toBe('max/tether');
  });

  it('reports the API error body', async () => {
    reply({ message: 'token is required' }, 401);
    await expect(client().testConnection()).rejects.toThrow('Gitea API 401: {"message":"token is required"}');
  });

  it('refuses a plain-HTTP server before any token is sent', () => {
    expect(() => new GiteaClient('http://git.example.com', 'secret-token')).toThrow('HTTPS');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('AdoClient', () => {
  const client = () => new AdoClient('https://dev.azure.com/', 'contoso', 'pat-value');
  const projects = { count: 2, value: [
    { id: 'p1', name: 'Platform', description: 'Core services' },
    { id: 'p2', name: 'Web', description: null },
  ] };

  it('sends the PAT as basic auth with an empty user name', async () => {
    reply({ count: 0, value: [] });

    await client().testConnection();

    const { url, init } = request();
    expect(url.href).toBe('https://dev.azure.com/contoso/_apis/projects?api-version=7.0&$top=1');
    expect(Buffer.from(init.headers.Authorization.replace('Basic ', ''), 'base64').toString()).toBe(':pat-value');
  });

  it('lists projects with empty descriptions normalized', async () => {
    reply(projects);

    expect(await client().listProjects()).toEqual([
      { id: 'p1', name: 'Platform', description: 'Core services' },
      { id: 'p2', name: 'Web', description: '' },
    ]);
  });

  it('collects repositories across projects and filters by name without regard to case', async () => {
    reply(projects);
    reply({ count: 2, value: [
      { id: 'r1', name: 'Tether', remoteUrl: 'https://dev.azure.com/contoso/Platform/_git/Tether', defaultBranch: 'refs/heads/develop' },
      { id: 'r2', name: 'billing', remoteUrl: 'https://dev.azure.com/contoso/Platform/_git/billing', defaultBranch: null },
    ] });
    reply({ count: 1, value: [
      { id: 'r3', name: 'tether-site', remoteUrl: 'https://dev.azure.com/contoso/Web/_git/tether-site', defaultBranch: null },
    ] });

    const repos = await client().listRepos('TETHER');

    expect(request(1).url.pathname).toBe('/contoso/Platform/_apis/git/repositories');
    expect(repos).toEqual([
      { fullName: 'Platform/Tether', cloneUrl: 'https://dev.azure.com/contoso/Platform/_git/Tether', description: 'Core services', defaultBranch: 'develop', isPrivate: true },
      { fullName: 'Web/tether-site', cloneUrl: 'https://dev.azure.com/contoso/Web/_git/tether-site', description: '', defaultBranch: 'main', isPrivate: true },
    ]);
  });

  it('returns every repository when there is no query', async () => {
    reply({ count: 1, value: [projects.value[0]] });
    reply({ count: 1, value: [{ id: 'r2', name: 'billing', remoteUrl: 'https://example.invalid/billing', defaultBranch: null }] });

    expect((await client().listRepos()).map(repo => repo.fullName)).toEqual(['Platform/billing']);
  });

  it('creates a repository inside the chosen project', async () => {
    reply({ id: 'r9', name: 'new-repo', remoteUrl: 'https://dev.azure.com/contoso/Platform/_git/new-repo', defaultBranch: null });

    const created = await client().createRepo({
      name: 'new-repo', isPrivate: true, description: 'Fresh', adoProject: { id: 'p1', name: 'Platform' },
    });

    const { url, init } = request();
    expect(url.pathname).toBe('/contoso/Platform/_apis/git/repositories');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'new-repo', project: { id: 'p1' } });
    expect(created).toEqual({
      fullName: 'Platform/new-repo', cloneUrl: 'https://dev.azure.com/contoso/Platform/_git/new-repo',
      description: 'Fresh', defaultBranch: 'main', isPrivate: true,
    });
  });

  it('requires a project to create a repository', async () => {
    await expect(client().createRepo({ name: 'orphan', isPrivate: true })).rejects.toThrow('requires a project');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
