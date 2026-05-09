import type { GitRepoInfo, CreateRepoOptions, AdoProjectInfo } from '../../../shared/types';
import { normalizeBaseUrl, requestJson } from './http';

export class AdoClient {
  private baseUrl: string;
  private organization: string;
  private authHeader: string;

  constructor(baseUrl: string, organization: string, token: string) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.organization = organization;
    this.authHeader = 'Basic ' + Buffer.from(':' + token).toString('base64');
  }

  private request<T>(path: string): Promise<T> {
    return requestJson<T>(this.url(path), 'ADO', {
      headers: this.headers(),
    });
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return requestJson<T>(this.url(path), 'ADO', {
      method: 'POST',
      headers: this.headers(),
      body,
    });
  }

  private url(path: string): string {
    return `${this.baseUrl}/${this.organization}${path}`;
  }

  private headers(): Record<string, string> {
    return {
      'Authorization': this.authHeader,
      'Accept': 'application/json',
    };
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

  async listProjects(): Promise<AdoProjectInfo[]> {
    const res = await this.request<AdoListResponse<AdoProject>>(
      '/_apis/projects?api-version=7.0&$top=100'
    );
    return res.value.map(p => ({
      id: p.id,
      name: p.name,
      description: p.description || '',
    }));
  }

  async createRepo(opts: CreateRepoOptions): Promise<GitRepoInfo> {
    if (!opts.adoProject) {
      throw new Error('ADO repo creation requires a project');
    }
    const created = await this.post<AdoRepo>(
      `/${opts.adoProject.name}/_apis/git/repositories?api-version=7.0`,
      {
        name: opts.name,
        project: { id: opts.adoProject.id },
      }
    );
    return {
      fullName: `${opts.adoProject.name}/${created.name}`,
      cloneUrl: created.remoteUrl,
      description: opts.description || '',
      defaultBranch: created.defaultBranch?.replace('refs/heads/', '') || 'main',
      isPrivate: true,
    };
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
