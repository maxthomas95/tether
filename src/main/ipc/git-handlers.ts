import { ipcMain } from 'electron';
import { IPC } from '../../shared/constants';
import type { GitProviderInfo, CreateGitProviderOptions, CreateRepoOptions } from '../../shared/types';
import * as gitProviderRepo from '../db/git-provider-repo';
import { gitClone, gitInit, gitWorktreeAdd, gitWorktreeRemove, isGitRepo, createFolder, gitRemoteAdd, gitBranchStatus } from '../git/git-service';
import { GiteaClient } from '../git/providers/gitea-client';
import { AdoClient } from '../git/providers/ado-client';
import { GitHubClient } from '../git/providers/github-client';
import { isVaultRef } from '../vault/vault-resolver';
import { createLogger } from '../logger';
import { resolveProviderToken, type HandlerContext } from './helpers';

const log = createLogger('ipc:git');

function toProviderInfo(row: gitProviderRepo.GitProviderRow): GitProviderInfo {
  const tokenIsVaultRef = isVaultRef(row.token);
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    baseUrl: row.baseUrl,
    organization: row.organization || undefined,
    defaultProject: row.defaultProject || undefined,
    hasToken: !!row.token,
    tokenIsVaultRef,
    tokenVaultRef: tokenIsVaultRef ? row.token : undefined,
  };
}

export function registerGitHandlers(ctx: HandlerContext): void {
  const { send } = ctx;

  // === Git Provider handlers ===

  ipcMain.handle(IPC.GIT_PROVIDER_LIST, async () => {
    return gitProviderRepo.listGitProviders().map(toProviderInfo);
  });

  ipcMain.handle(IPC.GIT_PROVIDER_CREATE, async (_event, opts: CreateGitProviderOptions) => {
    const row = gitProviderRepo.createGitProvider({
      name: opts.name,
      type: opts.type,
      baseUrl: opts.baseUrl,
      organization: opts.organization,
      defaultProject: opts.defaultProject,
      token: opts.token,
    });
    return toProviderInfo(row);
  });

  ipcMain.handle(IPC.GIT_PROVIDER_UPDATE, async (_event, id: string, opts: Partial<CreateGitProviderOptions>) => {
    gitProviderRepo.updateGitProvider(id, opts);
  });

  ipcMain.handle(IPC.GIT_PROVIDER_DELETE, async (_event, id: string) => {
    gitProviderRepo.deleteGitProvider(id);
  });

  ipcMain.handle(IPC.GIT_PROVIDER_TEST, async (_event, id: string) => {
    const provider = gitProviderRepo.getGitProvider(id);
    if (!provider) return { ok: false, error: 'Provider not found' };
    log.info('Testing git provider', { id, type: provider.type, baseUrl: provider.baseUrl });
    try {
      const token = await resolveProviderToken(provider.token);
      if (provider.type === 'gitea') {
        const client = new GiteaClient(provider.baseUrl, token);
        await client.testConnection();
      } else if (provider.type === 'github') {
        const client = new GitHubClient(provider.baseUrl, token);
        await client.testConnection();
      } else {
        const client = new AdoClient(provider.baseUrl, provider.organization || '', token);
        await client.testConnection();
      }
      return { ok: true };
    } catch (err: unknown) {
      log.error('Git provider test failed', { id, error: err instanceof Error ? err.message : String(err) });
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(IPC.GIT_PROVIDER_REPOS, async (_event, providerId: string, query?: string) => {
    const provider = gitProviderRepo.getGitProvider(providerId);
    if (!provider) throw new Error('Provider not found');
    const token = await resolveProviderToken(provider.token);
    if (provider.type === 'gitea') {
      const client = new GiteaClient(provider.baseUrl, token);
      return client.listRepos(query);
    } else if (provider.type === 'github') {
      const client = new GitHubClient(provider.baseUrl, token);
      return client.listRepos(query);
    } else {
      const client = new AdoClient(provider.baseUrl, provider.organization || '', token);
      return client.listRepos(query);
    }
  });

  ipcMain.handle(IPC.GIT_PROVIDER_LIST_PROJECTS, async (_event, providerId: string) => {
    const provider = gitProviderRepo.getGitProvider(providerId);
    if (!provider) throw new Error('Provider not found');
    if (provider.type !== 'ado') return [];
    const token = await resolveProviderToken(provider.token);
    const client = new AdoClient(provider.baseUrl, provider.organization || '', token);
    return client.listProjects();
  });

  ipcMain.handle(IPC.GIT_PROVIDER_CREATE_REPO, async (_event, providerId: string, opts: CreateRepoOptions) => {
    const provider = gitProviderRepo.getGitProvider(providerId);
    if (!provider) throw new Error('Provider not found');
    log.info('Git provider create repo', { providerId, type: provider.type, name: opts.name });
    const token = await resolveProviderToken(provider.token);
    if (provider.type === 'gitea') {
      const client = new GiteaClient(provider.baseUrl, token);
      return client.createRepo(opts);
    } else if (provider.type === 'github') {
      const client = new GitHubClient(provider.baseUrl, token);
      return client.createRepo(opts);
    } else {
      const client = new AdoClient(provider.baseUrl, provider.organization || '', token);
      return client.createRepo(opts);
    }
  });

  // === Git clone / init / folder / remote / worktree ===

  ipcMain.handle(IPC.GIT_CLONE, async (_event, url: string, destination: string) => {
    log.info('Git clone', { url, destination });
    return gitClone({
      url,
      destination,
      onProgress(info) {
        send(IPC.GIT_CLONE_PROGRESS, info);
      },
    });
  });

  ipcMain.handle(IPC.GIT_INIT, async (_event, directory: string) => {
    return gitInit(directory);
  });

  ipcMain.handle(IPC.GIT_CREATE_FOLDER, async (_event, path: string, initGit: boolean) => {
    log.info('Git create folder', { path, initGit });
    return createFolder({ path, initGit });
  });

  ipcMain.handle(IPC.GIT_REMOTE_ADD, async (_event, repoPath: string, remoteName: string, remoteUrl: string) => {
    log.info('Git remote add', { repoPath, remoteName });
    return gitRemoteAdd(repoPath, remoteName, remoteUrl);
  });

  ipcMain.handle(IPC.GIT_IS_REPO, async (_event, directory: string) => isGitRepo(directory));

  ipcMain.handle(IPC.GIT_BRANCH_STATUS, async (_event, directory: string) => gitBranchStatus(directory));

  ipcMain.handle(IPC.GIT_WORKTREE_ADD, async (_event, opts: { sourceRepo: string; worktreePath: string; branch: string }) => {
    log.info('Git worktree add', opts);
    return gitWorktreeAdd(opts);
  });

  ipcMain.handle(IPC.GIT_WORKTREE_REMOVE, async (_event, opts: { sourceRepo: string; worktreePath: string; force?: boolean }) => {
    log.info('Git worktree remove', opts);
    return gitWorktreeRemove(opts);
  });
}
