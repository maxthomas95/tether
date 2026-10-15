import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveCliExecutable } from './executable-resolver';

const tools = ['claude', 'codex', 'opencode'] as const;
const cmd = 'C:\\Windows\\System32\\cmd.exe';

describe.each(tools)('%s metadata executable', tool => {
  it('resolves npm shims from an absolute PATH directory with spaces', () => {
    const shim = `C:\\Program Files\\nodejs\\${tool}.CMD`;
    expect(resolveCliExecutable(tool, {
      platform: 'win32', pathEnv: '"C:\\Program Files\\nodejs"', pathExt: '.CMD', comSpec: cmd,
      args: ['session', 'list', '--format', 'json'],
      existsSync: file => [shim, cmd].includes(file),
    })).toEqual({
      kind: 'cmd', file: cmd,
      args: ['/d', '/v:off', '/s', '/c', `""${shim}" "session" "list" "--format" "json""`],
    });
  });

  it('prefers a native executable and preserves exact argv without a shell', () => {
    const native = `C:\\native\\${tool}.EXE`;
    const args = ['hello & goodbye', '日本語'];
    expect(resolveCliExecutable(tool, {
      platform: 'win32', pathEnv: 'C:\\npm;C:\\native', pathExt: '.CMD;.EXE', args,
      existsSync: file => file === native || file === `C:\\npm\\${tool}.CMD`,
    })).toEqual({ kind: 'direct', file: native, args });
  });

  it('does not use the working directory, relative PATH entries, or extensionless npm scripts', () => {
    expect(resolveCliExecutable(tool, {
      platform: 'win32', pathEnv: '.;node_modules\\.bin;C:\\npm', pathExt: '.EXE;.CMD',
      existsSync: file => [path.win32.resolve(`${tool}.EXE`), `C:\\npm\\${tool}`].includes(file),
    })).toBeNull();
  });

  it('rejects shell-expanding shim paths', () => {
    expect(resolveCliExecutable(tool, {
      platform: 'win32', pathEnv: 'C:\\%unsafe%', pathExt: '.CMD', comSpec: cmd,
      existsSync: () => true,
    })).toBeNull();
  });

  it('resolves a POSIX executable without trusting relative PATH entries', () => {
    expect(resolveCliExecutable(tool, {
      platform: 'linux', pathEnv: '.:node_modules/.bin:/opt/tools', args: ['--version'],
      existsSync: file => file === `/opt/tools/${tool}`,
    })).toEqual({ kind: 'direct', file: `/opt/tools/${tool}`, args: ['--version'] });
  });
});
