import type { GitRepoInfo } from '../../../shared/types';

export class GiteaClient {
  private baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
  }

  private async request<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}/api/v1${path}`, {
      headers: {
        'Authorization': `token ${this.token}`,
        'Accept': 'application/json',
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Gitea API ${res.status}: ${body || res.statusText}`);
    }
    return res.json() as Promise<T>;
  }

  async testConnection(): Promise<void> {
    await this.request<GiteaUser>('/user');
  }

  async listRepos(query?: string, page = 1, limit = 50): Promise<GitRepoInfo[]> {
    const q = (query || '').trim();

    // When there's no query, list the authenticated user's repos directly —
    // /repos/search with no constraints often only returns public repos.
    if (!q) {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
      });
      const raw = await this.request<unknown>(`/user/repos?${params}`);
      return extractRepos(raw).map(mapGiteaRepo);
    }

    const params = new URLSearchParams({
      q,
      page: String(page),
      limit: String(limit),
      sort: 'updated',
      order: 'desc',
    });
    const raw = await this.request<unknown>(`/repos/search?${params}`);
    return extractRepos(raw).map(mapGiteaRepo);
  }
}

// Handle both response shapes: a bare array, or { data: [...], ok: true }.
function extractRepos(raw: unknown): GiteaRepo[] {
  if (Array.isArray(raw)) return raw as GiteaRepo[];
  if (raw && typeof raw === 'object' && 'data' in raw) {
    const data = (raw as { data: unknown }).data;
    if (Array.isArray(data)) return data as GiteaRepo[];
  }
  return [];
}

function mapGiteaRepo(r: GiteaRepo): GitRepoInfo {
  return {
    fullName: r.full_name,
    cloneUrl: r.clone_url,
    description: r.description || '',
    defaultBranch: r.default_branch || 'main',
    isPrivate: r.private,
  };
}

interface GiteaRepo {
  full_name: string;
  clone_url: string;
  description: string | null;
  default_branch: string | null;
  private: boolean;
}

interface GiteaUser {
  id: number;
  login: string;
}
