import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHarness, makeElectronMockBase, type IpcRegistry } from './ipc-test-harness.test-helper';

const registry = vi.hoisted<IpcRegistry>(() => ({ handlers: new Map(), listeners: new Map() }));
vi.mock('electron', () => makeElectronMockBase(registry));

const gitProviderMocks = vi.hoisted(() => ({
  listGitProviders: vi.fn(),
  getGitProvider: vi.fn(),
  createGitProvider: vi.fn(),
  updateGitProvider: vi.fn(),
  deleteGitProvider: vi.fn(),
}));
vi.mock('../db/git-provider-repo', () => gitProviderMocks);

const gitServiceMocks = vi.hoisted(() => ({
  gitClone: vi.fn(),
  gitInit: vi.fn(),
  gitWorktreeAdd: vi.fn(),
  gitWorktreeRemove: vi.fn(),
  isGitRepo: vi.fn(),
  createFolder: vi.fn(),
  gitRemoteAdd: vi.fn(),
}));
vi.mock('../git/git-service', () => gitServiceMocks);

const giteaCtor = vi.hoisted(() => vi.fn());
const adoCtor = vi.hoisted(() => vi.fn());
const githubCtor = vi.hoisted(() => vi.fn());

const giteaInstance = vi.hoisted(() => ({
  testConnection: vi.fn(),
  listRepos: vi.fn(),
  createRepo: vi.fn(),
}));
const adoInstance = vi.hoisted(() => ({
  testConnection: vi.fn(),
  listRepos: vi.fn(),
  listProjects: vi.fn(),
  createRepo: vi.fn(),
}));
const githubInstance = vi.hoisted(() => ({
  testConnection: vi.fn(),
  listRepos: vi.fn(),
  createRepo: vi.fn(),
}));

vi.mock('../git/providers/gitea-client', () => ({
  GiteaClient: class {
    testConnection = giteaInstance.testConnection;
    listRepos = giteaInstance.listRepos;
    createRepo = giteaInstance.createRepo;
    constructor(...args: unknown[]) { giteaCtor(...args); }
  },
}));
vi.mock('../git/providers/ado-client', () => ({
  AdoClient: class {
    testConnection = adoInstance.testConnection;
    listRepos = adoInstance.listRepos;
    listProjects = adoInstance.listProjects;
    createRepo = adoInstance.createRepo;
    constructor(...args: unknown[]) { adoCtor(...args); }
  },
}));
vi.mock('../git/providers/github-client', () => ({
  GitHubClient: class {
    testConnection = githubInstance.testConnection;
    listRepos = githubInstance.listRepos;
    createRepo = githubInstance.createRepo;
    constructor(...args: unknown[]) { githubCtor(...args); }
  },
}));

const vaultResolverMocks = vi.hoisted(() => ({
  isVaultRef: vi.fn((v: unknown) => typeof v === 'string' && v.startsWith('vault://')),
  resolveRef: vi.fn().mockResolvedValue('resolved-token'),
}));
vi.mock('../vault/vault-resolver', () => vaultResolverMocks);

import { IPC } from '../../shared/constants';
import { registerGitHandlers } from './git-handlers';

const harness = createHarness(registry);

const fakeProvider = (overrides: Record<string, unknown> = {}) => ({
  id: 'gp-1',
  name: 'GH',
  type: 'github' as const,
  baseUrl: 'https://api.github.com',
  organization: null,
  defaultProject: null,
  token: 'plaintext-token',
  ...overrides,
});

describe('git-handlers', () => {
  beforeEach(() => {
    harness.reset();
    Object.values(gitProviderMocks).forEach((m) => m.mockReset());
    Object.values(gitServiceMocks).forEach((m) => m.mockReset());
    [...Object.values(giteaInstance), ...Object.values(adoInstance), ...Object.values(githubInstance)].forEach((m) => m.mockReset());
    giteaCtor.mockReset();
    adoCtor.mockReset();
    githubCtor.mockReset();
    vaultResolverMocks.isVaultRef.mockClear();
    vaultResolverMocks.resolveRef.mockClear();
    vaultResolverMocks.resolveRef.mockResolvedValue('resolved-token');
    registerGitHandlers(harness.ctx);
  });

  describe('GIT_PROVIDER_LIST', () => {
    it('maps repo rows to GitProviderInfo and flags vault tokens', async () => {
      gitProviderMocks.listGitProviders.mockReturnValue([
        fakeProvider({ id: 'gp-1', token: 'plain' }),
        fakeProvider({ id: 'gp-2', token: 'vault://secret/git#token' }),
      ]);
      const result = await harness.invoke<Array<{ id: string; hasToken: boolean; tokenIsVaultRef: boolean; tokenVaultRef?: string }>>(IPC.GIT_PROVIDER_LIST);
      expect(result[0]).toMatchObject({ id: 'gp-1', hasToken: true, tokenIsVaultRef: false, tokenVaultRef: undefined });
      expect(result[1]).toMatchObject({ id: 'gp-2', hasToken: true, tokenIsVaultRef: true, tokenVaultRef: 'vault://secret/git#token' });
    });
  });

  describe('GIT_PROVIDER_CREATE', () => {
    it('forwards opts and returns info shape', async () => {
      gitProviderMocks.createGitProvider.mockReturnValue(fakeProvider({ id: 'gp-new' }));
      const opts = { name: 'GH', type: 'github' as const, baseUrl: 'https://api.github.com', token: 'tok' };
      const result = await harness.invoke<{ id: string }>(IPC.GIT_PROVIDER_CREATE, opts);
      expect(gitProviderMocks.createGitProvider).toHaveBeenCalledWith(expect.objectContaining(opts));
      expect(result.id).toBe('gp-new');
    });
  });

  describe('GIT_PROVIDER_DELETE', () => {
    it('forwards id', async () => {
      await harness.invoke(IPC.GIT_PROVIDER_DELETE, 'gp-1');
      expect(gitProviderMocks.deleteGitProvider).toHaveBeenCalledWith('gp-1');
    });
  });

  describe('GIT_PROVIDER_TEST', () => {
    it('returns ok:false when provider is missing', async () => {
      gitProviderMocks.getGitProvider.mockReturnValue(undefined);
      const result = await harness.invoke<{ ok: boolean; error?: string }>(IPC.GIT_PROVIDER_TEST, 'gp-x');
      expect(result).toEqual({ ok: false, error: 'Provider not found' });
    });

    it('GitHub: instantiates client with resolved token + calls testConnection', async () => {
      gitProviderMocks.getGitProvider.mockReturnValue(fakeProvider({ token: 'vault://secret/g#tok', type: 'github' }));
      githubInstance.testConnection.mockResolvedValue(undefined);
      const result = await harness.invoke(IPC.GIT_PROVIDER_TEST, 'gp-1');
      expect(vaultResolverMocks.resolveRef).toHaveBeenCalledWith('vault://secret/g#tok');
      expect(githubCtor).toHaveBeenCalledWith('https://api.github.com', 'resolved-token');
      expect(githubInstance.testConnection).toHaveBeenCalled();
      expect(result).toEqual({ ok: true });
    });

    it('returns ok:false with error.message when testConnection throws', async () => {
      gitProviderMocks.getGitProvider.mockReturnValue(fakeProvider());
      githubInstance.testConnection.mockRejectedValue(new Error('401 Unauthorized'));
      const result = await harness.invoke<{ ok: boolean; error?: string }>(IPC.GIT_PROVIDER_TEST, 'gp-1');
      expect(result).toEqual({ ok: false, error: '401 Unauthorized' });
    });

    it('Gitea / ADO branch picks the right client', async () => {
      gitProviderMocks.getGitProvider.mockReturnValue(fakeProvider({ type: 'gitea', baseUrl: 'https://git.example.com' }));
      giteaInstance.testConnection.mockResolvedValue(undefined);
      await harness.invoke(IPC.GIT_PROVIDER_TEST, 'gp-1');
      expect(giteaCtor).toHaveBeenCalled();

      gitProviderMocks.getGitProvider.mockReturnValue(fakeProvider({ type: 'ado', baseUrl: 'https://dev.azure.com', organization: 'org' }));
      adoInstance.testConnection.mockResolvedValue(undefined);
      await harness.invoke(IPC.GIT_PROVIDER_TEST, 'gp-1');
      expect(adoCtor).toHaveBeenCalledWith('https://dev.azure.com', 'org', expect.any(String));
    });
  });

  describe('GIT_PROVIDER_REPOS', () => {
    it('throws when provider is missing', async () => {
      gitProviderMocks.getGitProvider.mockReturnValue(undefined);
      await expect(harness.invoke(IPC.GIT_PROVIDER_REPOS, 'gp-x', 'query')).rejects.toThrow(/Provider not found/);
    });

    it('routes to GitHubClient.listRepos with query', async () => {
      gitProviderMocks.getGitProvider.mockReturnValue(fakeProvider({ type: 'github' }));
      githubInstance.listRepos.mockResolvedValue([{ name: 'r' }]);
      const result = await harness.invoke(IPC.GIT_PROVIDER_REPOS, 'gp-1', 'tether');
      expect(githubInstance.listRepos).toHaveBeenCalledWith('tether');
      expect(result).toEqual([{ name: 'r' }]);
    });
  });

  describe('GIT_PROVIDER_LIST_PROJECTS', () => {
    it('returns [] for non-ADO providers', async () => {
      gitProviderMocks.getGitProvider.mockReturnValue(fakeProvider({ type: 'github' }));
      const result = await harness.invoke(IPC.GIT_PROVIDER_LIST_PROJECTS, 'gp-1');
      expect(result).toEqual([]);
    });

    it('calls AdoClient.listProjects for ADO', async () => {
      gitProviderMocks.getGitProvider.mockReturnValue(fakeProvider({ type: 'ado', organization: 'org' }));
      adoInstance.listProjects.mockResolvedValue([{ id: 'p1' }]);
      const result = await harness.invoke(IPC.GIT_PROVIDER_LIST_PROJECTS, 'gp-1');
      expect(result).toEqual([{ id: 'p1' }]);
    });
  });

  describe('GIT_PROVIDER_CREATE_REPO', () => {
    it('routes to the right client by provider type', async () => {
      gitProviderMocks.getGitProvider.mockReturnValue(fakeProvider({ type: 'github' }));
      githubInstance.createRepo.mockResolvedValue({ url: 'u' });
      const result = await harness.invoke(IPC.GIT_PROVIDER_CREATE_REPO, 'gp-1', { name: 'new' });
      expect(githubInstance.createRepo).toHaveBeenCalledWith({ name: 'new' });
      expect(result).toEqual({ url: 'u' });
    });
  });

  describe('local git operations', () => {
    it('GIT_CLONE delegates and pipes progress', async () => {
      gitServiceMocks.gitClone.mockImplementation(async (opts: { onProgress: (info: unknown) => void }) => {
        opts.onProgress({ pct: 50 });
        return { ok: true };
      });
      const result = await harness.invoke(IPC.GIT_CLONE, 'https://github.com/x/y', '/dest');
      expect(gitServiceMocks.gitClone).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://github.com/x/y', destination: '/dest' }));
      expect(harness.send).toHaveBeenCalledWith(IPC.GIT_CLONE_PROGRESS, { pct: 50 });
      expect(result).toEqual({ ok: true });
    });

    it('GIT_INIT / GIT_CREATE_FOLDER / GIT_REMOTE_ADD / GIT_IS_REPO forward args', async () => {
      gitServiceMocks.gitInit.mockResolvedValue({ ok: true });
      gitServiceMocks.createFolder.mockResolvedValue({ ok: true });
      gitServiceMocks.gitRemoteAdd.mockResolvedValue({ ok: true });
      gitServiceMocks.isGitRepo.mockReturnValue(true);

      await harness.invoke(IPC.GIT_INIT, '/dir');
      expect(gitServiceMocks.gitInit).toHaveBeenCalledWith('/dir');

      await harness.invoke(IPC.GIT_CREATE_FOLDER, '/new', true);
      expect(gitServiceMocks.createFolder).toHaveBeenCalledWith({ path: '/new', initGit: true });

      await harness.invoke(IPC.GIT_REMOTE_ADD, '/r', 'origin', 'https://x.git');
      expect(gitServiceMocks.gitRemoteAdd).toHaveBeenCalledWith('/r', 'origin', 'https://x.git');

      expect(await harness.invoke(IPC.GIT_IS_REPO, '/d')).toBe(true);
    });

    it('GIT_WORKTREE_ADD / GIT_WORKTREE_REMOVE forward opts', async () => {
      const addOpts = { sourceRepo: '/s', worktreePath: '/w', branch: 'b' };
      await harness.invoke(IPC.GIT_WORKTREE_ADD, addOpts);
      expect(gitServiceMocks.gitWorktreeAdd).toHaveBeenCalledWith(addOpts);

      const rmOpts = { sourceRepo: '/s', worktreePath: '/w', force: true };
      await harness.invoke(IPC.GIT_WORKTREE_REMOVE, rmOpts);
      expect(gitServiceMocks.gitWorktreeRemove).toHaveBeenCalledWith(rmOpts);
    });
  });
});
