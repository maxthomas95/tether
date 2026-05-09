import type { GitRepoInfo } from '../../../shared/types';

export class GitHubClient {
  private baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
  }

  private async request<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GitHub API ${res.status}: ${body || res.statusText}`);
    }
    return res.json() as Promise<T>;
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
