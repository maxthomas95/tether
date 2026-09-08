import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const files = vi.hoisted(() => new Set<string>());
vi.mock('node:fs', () => ({
  default: {
    constants: { F_OK: 0, X_OK: 1 },
    statSync: vi.fn((file: string) => ({ isFile: () => files.has(file) })),
    accessSync: vi.fn(),
  },
}));

import { resolveGitExecutable } from './git-executable';

beforeEach(() => {
  files.clear();
  vi.clearAllMocks();
  vi.mocked(fs.accessSync).mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('Git executable discovery', () => {
  it('skips implicit/relative cwd search, root-relative and device paths on Windows', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    vi.stubEnv('PATH', ';.;tools;C:tools;\\tools;/tools;\\\\?\\C:\\tools;C:\\Git\\cmd');
    files.add('C:\\Git\\cmd\\git.exe');
    expect(resolveGitExecutable()).toBe('C:\\Git\\cmd\\git.exe');
    expect(fs.statSync).toHaveBeenCalledTimes(1);
    expect(fs.statSync).toHaveBeenCalledWith('C:\\Git\\cmd\\git.exe');
  });

  it('preserves PATH ordering, quoted directories and spaces', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    vi.stubEnv('PATH', 'C:\\Missing;"C:\\My Git\\cmd";C:\\Other');
    files.add('C:\\My Git\\cmd\\git.exe');
    files.add('C:\\Other\\git.exe');
    expect(resolveGitExecutable()).toBe('C:\\My Git\\cmd\\git.exe');
  });

  it('does not fall back to a batch wrapper or cwd when Git is missing', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    vi.stubEnv('PATH', 'C:\\Tools');
    files.add('C:\\Tools\\git.cmd');
    expect(resolveGitExecutable).toThrow('Git executable not found');
    expect(fs.statSync).toHaveBeenCalledWith('C:\\Tools\\git.exe');
  });

  it('requires a regular executable file in an absolute POSIX PATH directory', () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' });
    vi.stubEnv('PATH', ':.:relative:/missing:/no-exec:/usr/bin');
    files.add('/no-exec/git');
    files.add('/usr/bin/git');
    vi.mocked(fs.accessSync).mockImplementation((file) => {
      if (file === '/no-exec/git') throw new Error('EACCES');
    });
    expect(resolveGitExecutable()).toBe('/usr/bin/git');
    expect(fs.statSync).toHaveBeenCalledTimes(3);
    expect(fs.accessSync).toHaveBeenCalledWith('/usr/bin/git', fs.constants.X_OK);
  });
});
