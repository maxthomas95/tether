import type { GitRepoInfo } from '../../../shared/types';

export class AdoClient {
  private baseUrl: string;
  private organization: string;
  private authHeader: string;

  constructor(baseUrl: string, organization: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.organization = organization;
    this.authHeader = 'Basic ' + Buffer.from(':' + token).toString('base64');
  }

  private async request<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}/${this.organization}${path}`;
    const res = await fetch(url, {
      headers: {
        'Authorization': this.authHeader,
        'Accept': 'application/json',
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`ADO API ${res.status}: ${body || res.statusText}`);
    }
    return res.json() as Promise<T>;
  }

  async testConnection(): Promise<void> {
    await this.request<unknown>('/_apis/projects?api-version=7.0&$top=1');
  }

  async listRepos(query?: string): Promise<GitRepoInfo[]> {
    // First get all projects, then repos within them
    const projectsRes = await this.request<AdoListResponse<AdoProject>>(
      '/_apis/projects?api-version=7.0&$top=100'
    );

    const allRepos: GitRepoInfo[] = [];

    for (const project of projectsRes.value) {
      const reposRes = await this.request<AdoListResponse<AdoRepo>>(
        `/${project.name}/_apis/git/repositories?api-version=7.0`
      );

      for (const r of reposRes.value) {
        if (query && !r.name.toLowerCase().includes(query.toLowerCase())) continue;
        allRepos.push({
          fullName: `${project.name}/${r.name}`,
          cloneUrl: r.remoteUrl,
          description: project.description || '',
          defaultBranch: r.defaultBranch?.replace('refs/heads/', '') || 'main',
          isPrivate: true,
        });
      }
    }

    return allRepos;
  }
}

interface AdoListResponse<T> {
  count: number;
  value: T[];
}

interface AdoProject {
  id: string;
  name: string;
  description: string | null;
}

interface AdoRepo {
  id: string;
  name: string;
  remoteUrl: string;
  defaultBranch: string | null;
}
