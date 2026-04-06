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
    await this.request<unknown>('/user');
  }

  async listRepos(query?: string, page = 1, limit = 50): Promise<GitRepoInfo[]> {
    const params = new URLSearchParams({
      page: String(page),
      limit: String(limit),
      sort: 'updated',
      order: 'desc',
    });
    if (query) params.set('q', query);

    const repos = await this.request<GiteaRepo[]>(`/repos/search?${params}`);
    return repos.map(r => ({
      fullName: r.full_name,
      cloneUrl: r.clone_url,
      description: r.description || '',
      defaultBranch: r.default_branch || 'main',
      isPrivate: r.private,
    }));
  }
}

interface GiteaRepo {
  full_name: string;
  clone_url: string;
  description: string | null;
  default_branch: string | null;
  private: boolean;
}
