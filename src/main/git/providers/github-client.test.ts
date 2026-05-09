import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GitHubClient } from './github-client';

interface MockResponse {
  ok: boolean;
  status: number;
  statusText: string;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}

function makeResponse(status: number, body: unknown): MockResponse {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `Status ${status}`,
    text: async () => text,
    json: async () => (typeof body === 'string' ? JSON.parse(text) : body),
  };
}

function makeRepo(fullName: string, overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    full_name: fullName,
    clone_url: `https://github.com/${fullName}.git`,
    description: `desc for ${fullName}`,
    default_branch: 'main',
    private: false,
    ...overrides,
  };
}

describe('GitHubClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = global.fetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('testConnection', () => {
    it('resolves on 200 from /user', async () => {
      fetchMock.mockResolvedValueOnce(makeResponse(200, { id: 1, login: 'octocat' }));
      const client = new GitHubClient('https://api.github.com', 'token-abc');
      await expect(client.testConnection()).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.github.com/user');
      const headers = (init as { headers: Record<string, string> }).headers;
      expect(headers['Authorization']).toBe('Bearer token-abc');
      expect(headers['Accept']).toBe('application/vnd.github+json');
      expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28');
    });

    it('rejects on 401 with a recognizable error message', async () => {
      fetchMock.mockResolvedValue(makeResponse(401, '{"message":"Bad credentials"}'));
      const client = new GitHubClient('https://api.github.com', 'bad-token');
      await expect(client.testConnection()).rejects.toThrow(/GitHub API 401/);
      await expect(client.testConnection()).rejects.toThrow(/Bad credentials/);
    });

    it('strips trailing slashes from baseUrl', async () => {
      fetchMock.mockResolvedValueOnce(makeResponse(200, { id: 1, login: 'octocat' }));
      const client = new GitHubClient('https://api.github.com///', 'token');
      await client.testConnection();
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/user');
    });
  });

  describe('listRepos', () => {
    it('paginates correctly and stops when a page returns fewer than 100 items', async () => {
      const page1 = Array.from({ length: 100 }, (_, i) => makeRepo(`alice/repo-${i + 1}`));
      const page2 = Array.from({ length: 50 }, (_, i) => makeRepo(`alice/repo-${i + 101}`));
      fetchMock
        .mockResolvedValueOnce(makeResponse(200, page1))
        .mockResolvedValueOnce(makeResponse(200, page2));

      const client = new GitHubClient('https://api.github.com', 'token');
      const repos = await client.listRepos();

      expect(repos).toHaveLength(150);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toContain('per_page=100');
      expect(fetchMock.mock.calls[0][0]).toContain('page=1');
      expect(fetchMock.mock.calls[0][0]).toContain('sort=updated');
      expect(fetchMock.mock.calls[0][0]).toContain('direction=desc');
      expect(fetchMock.mock.calls[1][0]).toContain('page=2');
    });

    it('stops at maxPages=3 when every page is full', async () => {
      const fullPage = Array.from({ length: 100 }, (_, i) => makeRepo(`alice/repo-${i}`));
      fetchMock
        .mockResolvedValueOnce(makeResponse(200, fullPage))
        .mockResolvedValueOnce(makeResponse(200, fullPage))
        .mockResolvedValueOnce(makeResponse(200, fullPage));

      const client = new GitHubClient('https://api.github.com', 'token');
      const repos = await client.listRepos();

      expect(repos).toHaveLength(300);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('filters client-side by query against fullName', async () => {
      const page1 = [
        makeRepo('alice/tether'),
        makeRepo('alice/other'),
        makeRepo('bob/tether-fork'),
        makeRepo('carol/unrelated'),
      ];
      fetchMock.mockResolvedValueOnce(makeResponse(200, page1));

      const client = new GitHubClient('https://api.github.com', 'token');
      const repos = await client.listRepos('tether');

      expect(repos).toHaveLength(2);
      expect(repos.map(r => r.fullName).sort()).toEqual(['alice/tether', 'bob/tether-fork']);
    });

    it('matches case-insensitively', async () => {
      const page1 = [makeRepo('Alice/Tether')];
      fetchMock.mockResolvedValueOnce(makeResponse(200, page1));

      const client = new GitHubClient('https://api.github.com', 'token');
      const repos = await client.listRepos('TETHER');
      expect(repos).toHaveLength(1);
    });

    it('maps GitHub fields to GitRepoInfo correctly', async () => {
      const page1 = [
        {
          full_name: 'alice/secret',
          clone_url: 'https://github.com/alice/secret.git',
          description: 'private repo',
          default_branch: 'develop',
          private: true,
        },
      ];
      fetchMock.mockResolvedValueOnce(makeResponse(200, page1));

      const client = new GitHubClient('https://api.github.com', 'token');
      const repos = await client.listRepos();

      expect(repos[0]).toEqual({
        fullName: 'alice/secret',
        cloneUrl: 'https://github.com/alice/secret.git',
        description: 'private repo',
        defaultBranch: 'develop',
        isPrivate: true,
      });
    });

    it('defaults missing description and default_branch', async () => {
      const page1 = [
        {
          full_name: 'alice/empty',
          clone_url: 'https://github.com/alice/empty.git',
          description: null,
          default_branch: null,
          private: false,
        },
      ];
      fetchMock.mockResolvedValueOnce(makeResponse(200, page1));

      const client = new GitHubClient('https://api.github.com', 'token');
      const repos = await client.listRepos();

      expect(repos[0].description).toBe('');
      expect(repos[0].defaultBranch).toBe('main');
    });
  });
});
