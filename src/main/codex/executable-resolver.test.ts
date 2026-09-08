import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveCodexExecutable, resolveWindowsSystemExecutable } from './executable-resolver';

const win = path.win32;

function existsFor(files: string[]) {
  const known = new Set(files.map(file => win.normalize(file).toLowerCase()));
  return (file: string) => known.has(win.normalize(file).toLowerCase());
}

describe('resolveCodexExecutable', () => {
  it('does not fall back to a malicious executable in the current directory', () => {
    expect(resolveCodexExecutable({
      platform: 'win32',
      pathEnv: '',
      existsSync: existsFor([win.resolve('codex.exe')]),
    })).toBeNull();
  });

  it('skips relative and device PATH entries on Windows', () => {
    const trusted = 'C:\\Program Files\\Codex\\codex.EXE';
    expect(resolveCodexExecutable({
      platform: 'win32',
      pathEnv: ['.', '\\unsafe', 'node_modules\\.bin', '\\\\?\\C:\\unsafe', 'C:\\Program Files\\Codex'].join(';'),
      pathExt: '.EXE;.CMD',
      existsSync: existsFor([
        win.resolve('node_modules\\.bin\\codex.EXE'),
        '\\\\?\\C:\\unsafe\\codex.EXE',
        trusted,
      ]),
    })).toEqual({ kind: 'direct', file: trusted, args: ['app-server'] });
  });

  it('prefers a native Windows executable over a later npm cmd shim', () => {
    const exe = 'C:\\tools\\codex.EXE';
    const shim = 'C:\\nodejs\\codex.CMD';
    expect(resolveCodexExecutable({
      platform: 'win32',
      pathEnv: 'C:\\nodejs;C:\\tools',
      pathExt: '.CMD;.EXE',
      existsSync: existsFor([shim, exe]),
    })).toEqual({ kind: 'direct', file: exe, args: ['app-server'] });
  });

  it('supports a Windows npm cmd shim installed under a path with spaces', () => {
    const shim = 'C:\\Program Files\\nodejs\\codex.CMD';
    expect(resolveCodexExecutable({
      platform: 'win32',
      pathEnv: '"C:\\Program Files\\nodejs"',
      pathExt: '.CMD;.EXE',
      comSpec: 'C:\\Windows\\System32\\cmd.exe',
      existsSync: existsFor([shim, 'C:\\Windows\\System32\\cmd.exe']),
    })).toEqual({
      kind: 'cmd',
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/v:off', '/s', '/c', '""C:\\Program Files\\nodejs\\codex.CMD" app-server"'],
    });
  });

  it('skips relative POSIX PATH entries', () => {
    expect(resolveCodexExecutable({
      platform: 'linux',
      pathEnv: '.:node_modules/.bin:/opt/codex/bin',
      existsSync: file => file === '/opt/codex/bin/codex',
    })).toEqual({ kind: 'direct', file: '/opt/codex/bin/codex', args: ['app-server'] });
  });
});

describe('resolveWindowsSystemExecutable', () => {
  it('does not fall back to cwd lookup without an absolute system executable', () => {
    expect(resolveWindowsSystemExecutable('cmd.exe', { comSpec: '', systemRoot: '', existsSync: () => false })).toBeNull();
  });
  it('resolves taskkill from System32 when present', () => {
    expect(resolveWindowsSystemExecutable('taskkill.exe', {
      platform: 'win32',
      systemRoot: 'C:\\Windows',
      existsSync: existsFor(['C:\\Windows\\System32\\taskkill.exe']),
    })).toBe('C:\\Windows\\System32\\taskkill.exe');
  });

  it('uses absolute ComSpec for cmd.exe when present', () => {
    expect(resolveWindowsSystemExecutable('cmd.exe', {
      platform: 'win32',
      comSpec: 'C:\\Windows\\System32\\cmd.exe',
      systemRoot: 'C:\\OtherWindows',
      existsSync: existsFor(['C:\\Windows\\System32\\cmd.exe', 'C:\\OtherWindows\\System32\\cmd.exe']),
    })).toBe('C:\\Windows\\System32\\cmd.exe');
  });
});
