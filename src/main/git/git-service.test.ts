import { EventEmitter } from 'node:events';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn());
const mkdirSyncMock = vi.hoisted(() => vi.fn());
const gitExecutable = '/test-tools/git';
vi.mock('./git-executable', () => ({ resolveGitExecutable: vi.fn(() => '/test-tools/git') }));

vi.mock('node:child_process', () => ({ spawn: spawnMock }));
vi.mock('node:fs', () => ({
  default: { existsSync: existsSyncMock, mkdirSync: mkdirSyncMock },
  existsSync: existsSyncMock,
  mkdirSync: mkdirSyncMock,
}));

import {
  createFolder,
  gitBranchStatus,
  gitClone,
  gitInit,
  gitRemoteAdd,
  gitWorktreeAdd,
  gitWorktreeRemove,
  parsePorcelainStatus,
} from './git-service';
import { resolveGitExecutable } from './git-executable';

function fakeProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}

describe('git-service hardening', () => {
  beforeEach(() => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    spawnMock.mockReset();
    existsSyncMock.mockReset();
    mkdirSyncMock.mockReset();
    existsSyncMock.mockReturnValue(false);
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each(['relative', 'C:relative', '/root-relative', '\\root-relative', '\\\\?\\C:\\repo', '//?/C:/repo', '\\\\.\\C:\\repo', 42])(
    'rejects unsafe Windows path %j before filesystem access', async (directory) => {
      await expect(gitInit(directory as string)).rejects.toThrow();
      expect(existsSyncMock).not.toHaveBeenCalled();
      expect(mkdirSyncMock).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
    },
  );

  it('supports an absolute POSIX path with Unicode and spaces', async () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' });
    await expect(createFolder({ path: '/tmp/日本語 repo', initGit: false })).resolves.toBe('/tmp/日本語 repo');
    expect(mkdirSyncMock).toHaveBeenCalledWith('/tmp/日本語 repo', { recursive: true });
  });

  it('supports a normal Windows UNC share', async () => {
    await expect(createFolder({ path: '\\\\server\\share\\repo', initGit: false })).resolves.toBe('\\\\server\\share\\repo');
    expect(mkdirSyncMock).toHaveBeenCalledWith('\\\\server\\share\\repo', { recursive: true });
  });

  it.each(['--detach', 'feature/../main', 'feature//name', '.hidden', 'feature/.hidden', 'feature.lock/child', 'HEAD', '@', 'name\tbranch', 'name@{1}', 'name\\branch', 'name:branch'])(
    'rejects malformed branch %j before filesystem access', async (branch) => {
      await expect(gitWorktreeAdd({ sourceRepo: 'C:/repo/source', worktreePath: 'C:/repo/target', branch })).rejects.toThrow('Branch name is invalid');
      expect(existsSyncMock).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
    },
  );

  it('uses -- and a protocol allowlist for clone', async () => {
    const proc = fakeProc();
    spawnMock.mockReturnValue(proc);
    const promise = gitClone({ url: 'https://github.com/example/repo.git', destination: 'C:/repo/out' });
    proc.emit('close', 0);
    await expect(promise).resolves.toBe('C:\\repo\\out');

    expect(spawnMock).toHaveBeenCalledWith(gitExecutable, [
      'clone',
      '--progress',
      '--',
      'https://github.com/example/repo.git',
      'C:\\repo\\out',
    ], expect.objectContaining({
      env: expect.objectContaining({ GIT_ALLOW_PROTOCOL: 'https:ssh' }),
    }));
  });

  it('rejects dangerous clone URLs before spawning git', async () => {
    await expect(gitClone({ url: 'ext::sh -c calc', destination: 'C:/repo/out' })).rejects.toThrow(/not allowed/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects invalid clone destinations before checking the filesystem', async () => {
    await expect(gitClone({ url: 'https://github.com/example/repo.git', destination: '..\\out' })).rejects.toThrow(/absolute path/);
    await expect(gitClone({ url: 'https://github.com/example/repo.git', destination: 'C:\\repo\\bad\npath' })).rejects.toThrow(/invalid characters/);

    expect(existsSyncMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('initializes git with a validated absolute path after --', async () => {
    const proc = fakeProc();
    spawnMock.mockReturnValue(proc);
    const promise = gitInit('C:/repo/new project');
    proc.emit('close', 0);
    await expect(promise).resolves.toBe('C:\\repo\\new project');

    expect(mkdirSyncMock).toHaveBeenCalledWith('C:\\repo\\new project', { recursive: true });
    expect(spawnMock).toHaveBeenCalledWith(gitExecutable, [
      'init',
      '--',
      'C:\\repo\\new project',
    ], expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }));
  });

  it('rejects invalid init paths before filesystem side effects', async () => {
    await expect(gitInit('--upload-pack=calc')).rejects.toThrow(/absolute path/);
    await expect(gitInit('C:\\repo\\bad\0path')).rejects.toThrow(/invalid characters/);

    expect(existsSyncMock).not.toHaveBeenCalled();
    expect(mkdirSyncMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('creates a folder with spaces without spawning git when initGit is false', async () => {
    await expect(createFolder({ path: 'C:/repo/new project', initGit: false })).resolves.toBe('C:\\repo\\new project');

    expect(mkdirSyncMock).toHaveBeenCalledWith('C:\\repo\\new project', { recursive: true });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects invalid folder paths before filesystem side effects', async () => {
    await expect(createFolder({ path: '\\root-relative', initGit: false })).rejects.toThrow(/drive-absolute or a UNC path/);

    expect(existsSyncMock).not.toHaveBeenCalled();
    expect(mkdirSyncMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('uses -- and a protocol allowlist for remote add', async () => {
    existsSyncMock.mockReturnValue(true);
    const proc = fakeProc();
    spawnMock.mockReturnValue(proc);
    const promise = gitRemoteAdd('C:/repo/project', 'origin', 'git@github.com:example/repo.git');
    proc.emit('close', 0);
    await expect(promise).resolves.toBeUndefined();

    expect(spawnMock).toHaveBeenCalledWith(gitExecutable, [
      'remote',
      'add',
      '--',
      'origin',
      'git@github.com:example/repo.git',
    ], expect.objectContaining({
      cwd: 'C:\\repo\\project',
      env: expect.objectContaining({ GIT_ALLOW_PROTOCOL: 'https:ssh' }),
    }));
  });

  it('rejects invalid remote-add repository paths before repo checks', async () => {
    await expect(gitRemoteAdd('C:\\repo\\bad\rpath', 'origin', 'https://github.com/example/repo.git')).rejects.toThrow(/invalid characters/);

    expect(existsSyncMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('adds worktrees with validated cwd, branch, and end-of-options path marker', async () => {
    existsSyncMock
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const proc = fakeProc();
    spawnMock.mockReturnValue(proc);

    const promise = gitWorktreeAdd({
      sourceRepo: 'C:/repo/source project',
      worktreePath: 'C:/repo/worktree target',
      branch: 'feature/sonar-fix',
    });
    proc.emit('close', 0);

    await expect(promise).resolves.toBe('C:\\repo\\worktree target');
    expect(spawnMock).toHaveBeenCalledWith(gitExecutable, [
      'worktree',
      'add',
      '-b',
      'feature/sonar-fix',
      '--',
      'C:\\repo\\worktree target',
    ], expect.objectContaining({
      cwd: 'C:\\repo\\source project',
    }));
  });

  it('rejects invalid worktree branch names before repo checks', async () => {
    await expect(gitWorktreeAdd({
      sourceRepo: 'C:/repo/source',
      worktreePath: 'C:/repo/target',
      branch: '-upload-pack=calc',
    })).rejects.toThrow(/Branch name is invalid/);
    await expect(gitWorktreeAdd({
      sourceRepo: 'C:/repo/source',
      worktreePath: 'C:/repo/target',
      branch: 'feature/../main',
    })).rejects.toThrow(/Branch name is invalid/);

    expect(existsSyncMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('removes worktrees with a validated cwd and end-of-options path marker', async () => {
    existsSyncMock.mockReturnValue(true);
    const proc = fakeProc();
    spawnMock.mockReturnValue(proc);

    const promise = gitWorktreeRemove({
      sourceRepo: 'C:/repo/source project',
      worktreePath: 'C:/repo/worktree target',
      force: true,
    });
    proc.emit('close', 0);

    await expect(promise).resolves.toBeUndefined();
    expect(spawnMock).toHaveBeenCalledWith(gitExecutable, [
      'worktree',
      'remove',
      '--force',
      '--',
      'C:\\repo\\worktree target',
    ], expect.objectContaining({
      cwd: 'C:\\repo\\source project',
    }));
  });
});

describe.each(['win32', 'linux'])('literal branch arguments on %s', (platform) => {
  beforeEach(() => {
    vi.stubGlobal('process', { ...process, platform });
    spawnMock.mockReset();
    existsSyncMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(['feature/日本語', 'feature/$(whoami)', 'feature/topic+1'])(
    'passes valid branch %j as one literal argument without a shell', async (branch) => {
      existsSyncMock.mockReturnValueOnce(true).mockReturnValueOnce(false);
      const proc = fakeProc();
      spawnMock.mockReturnValue(proc);
      const sourceRepo = platform === 'win32' ? 'C:\\source' : '/source';
      const worktreePath = platform === 'win32' ? 'C:\\target' : '/target';
      const result = gitWorktreeAdd({ sourceRepo, worktreePath, branch });
      proc.emit('close', 0);
      await result;
      expect(spawnMock).toHaveBeenCalledWith(gitExecutable,
        ['worktree', 'add', '-b', branch, '--', worktreePath],
        { cwd: sourceRepo, stdio: ['ignore', 'pipe', 'pipe'] });
    },
  );
});

describe('parsePorcelainStatus', () => {
  it('parses a clean repo (branch only, no entries)', () => {
    const stdout = [
      '# branch.oid abc123',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +0 -0',
      '',
    ].join('\n');
    expect(parsePorcelainStatus(stdout)).toEqual({ branch: 'main', dirtyCount: 0 });
  });

  it('counts staged, unstaged, and untracked entries', () => {
    const stdout = [
      '# branch.head feature/x',
      '1 .M N... 100644 100644 100644 aaaa bbbb src/a.ts',
      '1 M. N... 100644 100644 100644 aaaa bbbb src/b.ts',
      '2 R. N... 100644 100644 100644 aaaa bbbb src/c.ts\tsrc/old.ts',
      'u UU N... 100644 100644 100644 100644 aaaa bbbb cccc dddd src/conflict.ts',
      '? src/new-file.ts',
      '',
    ].join('\n');
    expect(parsePorcelainStatus(stdout)).toEqual({ branch: 'feature/x', dirtyCount: 5 });
  });

  it('passes detached HEAD through as-is', () => {
    const stdout = '# branch.head (detached)\n# branch.oid abc123\n';
    expect(parsePorcelainStatus(stdout)).toEqual({ branch: '(detached)', dirtyCount: 0 });
  });

  it('returns an empty branch and zero count for empty input', () => {
    expect(parsePorcelainStatus('')).toEqual({ branch: '', dirtyCount: 0 });
  });
});

describe('gitBranchStatus', () => {
  it('returns null when the Git executable cannot be resolved', async () => {
    vi.mocked(resolveGitExecutable).mockImplementationOnce(() => { throw new Error('Git not found'); });
    const calls = spawnMock.mock.calls.length;
    await expect(gitBranchStatus('C:/repo/project')).resolves.toBeNull();
    expect(spawnMock.mock.calls).toHaveLength(calls);
  });

  it('resolves branch + dirty count on success', async () => {
    const proc = fakeProc();
    spawnMock.mockReturnValue(proc);
    const promise = gitBranchStatus('C:/repo/project');
    proc.stdout.emit('data', Buffer.from('# branch.head main\n1 .M N... 100644 100644 100644 aaaa bbbb src/a.ts\n'));
    proc.emit('close', 0);
    await expect(promise).resolves.toEqual({ branch: 'main', dirtyCount: 1 });
    expect(spawnMock).toHaveBeenCalledWith(gitExecutable, [
      '-C', 'C:/repo/project', 'status', '--porcelain=v2', '--branch',
    ], expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }));
  });

  it('resolves null on non-zero exit', async () => {
    const proc = fakeProc();
    spawnMock.mockReturnValue(proc);
    const promise = gitBranchStatus('C:/not/a/repo');
    proc.emit('close', 128);
    await expect(promise).resolves.toBeNull();
  });

  it('resolves null on spawn error', async () => {
    const proc = fakeProc();
    spawnMock.mockReturnValue(proc);
    const promise = gitBranchStatus('C:/repo/project');
    proc.emit('error', new Error('ENOENT'));
    await expect(promise).resolves.toBeNull();
  });

  it('kills the process and resolves null on timeout', async () => {
    vi.useFakeTimers();
    try {
      const proc = fakeProc();
      spawnMock.mockReturnValue(proc);
      const promise = gitBranchStatus('//slow/network/share');
      vi.advanceTimersByTime(5_000);
      await expect(promise).resolves.toBeNull();
      expect(proc.kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

