import { EventEmitter } from 'node:events';
import { describe, expect, it, beforeEach, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ spawn: spawnMock }));
vi.mock('node:fs', () => ({
  default: { existsSync: existsSyncMock, mkdirSync: vi.fn() },
  existsSync: existsSyncMock,
  mkdirSync: vi.fn(),
}));

import { gitClone, gitRemoteAdd, gitBranchStatus, parsePorcelainStatus } from './git-service';

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
    spawnMock.mockReset();
    existsSyncMock.mockReset();
    existsSyncMock.mockReturnValue(false);
  });

  it('uses -- and a protocol allowlist for clone', async () => {
    const proc = fakeProc();
    spawnMock.mockReturnValue(proc);
    const promise = gitClone({ url: 'https://github.com/example/repo.git', destination: 'C:/repo/out' });
    proc.emit('close', 0);
    await expect(promise).resolves.toBe('C:/repo/out');

    expect(spawnMock).toHaveBeenCalledWith('git', [
      'clone',
      '--progress',
      '--',
      'https://github.com/example/repo.git',
      'C:/repo/out',
    ], expect.objectContaining({
      env: expect.objectContaining({ GIT_ALLOW_PROTOCOL: 'https:ssh' }),
    }));
  });

  it('rejects dangerous clone URLs before spawning git', async () => {
    await expect(gitClone({ url: 'ext::sh -c calc', destination: 'C:/repo/out' })).rejects.toThrow(/not allowed/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('uses -- and a protocol allowlist for remote add', async () => {
    existsSyncMock.mockReturnValue(true);
    const proc = fakeProc();
    spawnMock.mockReturnValue(proc);
    const promise = gitRemoteAdd('C:/repo/project', 'origin', 'git@github.com:example/repo.git');
    proc.emit('close', 0);
    await expect(promise).resolves.toBeUndefined();

    expect(spawnMock).toHaveBeenCalledWith('git', [
      '-C',
      'C:/repo/project',
      'remote',
      'add',
      '--',
      'origin',
      'git@github.com:example/repo.git',
    ], expect.objectContaining({
      env: expect.objectContaining({ GIT_ALLOW_PROTOCOL: 'https:ssh' }),
    }));
  });
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
  it('resolves branch + dirty count on success', async () => {
    const proc = fakeProc();
    spawnMock.mockReturnValue(proc);
    const promise = gitBranchStatus('C:/repo/project');
    proc.stdout.emit('data', Buffer.from('# branch.head main\n1 .M N... 100644 100644 100644 aaaa bbbb src/a.ts\n'));
    proc.emit('close', 0);
    await expect(promise).resolves.toEqual({ branch: 'main', dirtyCount: 1 });
    expect(spawnMock).toHaveBeenCalledWith('git', [
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

