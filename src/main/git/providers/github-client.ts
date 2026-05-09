import type { GitRepoInfo, CreateRepoOptions } from '../../../shared/types';
import { normalizeBaseUrl, requestJson } from './http';

export class GitHubClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.token = token;
  }

  private request<T>(path: string): Promise<T> {
    return requestJson<T>(`${this.baseUrl}${path}`, 'GitHub', {
      headers: this.headers(),
    });
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return requestJson<T>(`${this.baseUrl}${path}`, 'GitHub', {
      method: 'POST',
      headers: this.headers(),
      body,
    });
  }

  private headers(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  async testConnection(): Promise<void> {
    await this.request<GitHubUser>('/user');
  }

  async listRepos(query?: string): Promise<GitRepoInfo[]> {
    // /user/repos is PAT-scoped (owner + collaborator + org-member). We avoid
    // /search/repositories because it's a global index and would surface repos
    // outside the user's reach. Filter client-side after pagination.
    const perPage = 100;
    const maxPages = 3;
    const all: GitHubRepo[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const params = new URLSearchParams({
        per_page: String(perPage),
        page: String(page),
        sort: 'updated',
        direction: 'desc',
      });
      const batch = await this.request<GitHubRepo[]>(`/user/repos?${params}`);
      all.push(...batch);
      if (batch.length < perPage) break;
    }

    const mapped = all.map(mapGitHubRepo);
    const q = (query || '').trim().toLowerCase();
    if (!q) return mapped;
    return mapped.filter(r => r.fullName.toLowerCase().includes(q));
  }

  async createRepo(opts: CreateRepoOptions): Promise<GitRepoInfo> {
    const created = await this.post<GitHubRepo>('/user/repos', {
      name: opts.name,
      description: opts.description || '',
      private: opts.isPrivate,
      auto_init: false,
    });
    return mapGitHubRepo(created);
  }
}

function mapGitHubRepo(r: GitHubRepo): GitRepoInfo {
  return {
    fullName: r.full_name,
    cloneUrl: r.clone_url,
    description: r.description || '',
    defaultBranch: r.default_branch || 'main',
    isPrivate: r.private,
  };
}

interface GitHubRepo {
  full_name: string;
  clone_url: string;
  description: string | null;
  default_branch: string | null;
  private: boolean;
}

interface GitHubUser {
  id: number;
  login: string;
}
