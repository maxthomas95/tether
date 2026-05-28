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

import { gitClone, gitRemoteAdd } from './git-service';

function fakeProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
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

