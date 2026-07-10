import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveWindowsLaunch } from './win-binary-resolver';

// The resolver models Windows semantics via path.win32, so tests build their
// fixtures with path.win32 too and run identically on any host OS.
const win = path.win32;

function resolverFor(files: string[], pathEnv = 'C:\\tools', pathExt = '.COM;.EXE;.BAT;.CMD') {
  const known = new Set(files.map(file => win.normalize(file).toLowerCase()));
  return (binary: string) => resolveWindowsLaunch(binary, {
    pathEnv,
    pathExt,
    existsSync: candidate => known.has(win.normalize(candidate).toLowerCase()),
  });
}

describe('resolveWindowsLaunch', () => {
  it('resolves a bare executable directly', () => {
    // Default PATHEXT declares .EXE, so the appended extension is upper-cased;
    // the case-insensitive existsSync still matches an on-disk claude.exe.
    const file = win.resolve('C:\\tools', 'claude.EXE');
    expect(resolverFor([file])('claude')).toEqual({ kind: 'direct', file });
  });

  it('routes a bare batch shim through cmd.exe', () => {
    const file = win.resolve('C:\\tools', 'coder.CMD');
    expect(resolverFor([file], 'C:\\tools', '.CMD;.EXE')('coder')).toEqual({ kind: 'shell', file });
  });

  it('resolves an explicit executable path directly', () => {
    const file = win.resolve('C:\\tools', 'custom.EXE');
    expect(resolverFor([file])(file)).toEqual({ kind: 'direct', file });
  });

  it('tries PATHEXT for explicit extensionless paths', () => {
    const base = win.resolve('C:\\tools', 'custom');
    const file = `${base}.COM`;
    expect(resolverFor([file], '', '.COM;.EXE')(base)).toEqual({ kind: 'direct', file });
  });

  it('uses an explicit extensionless path that exists as-is', () => {
    const file = win.resolve('C:\\tools', 'custom');
    expect(resolverFor([file], '', '.COM;.EXE')(file)).toEqual({ kind: 'direct', file });
  });

  it('falls back to the shell for an unresolved command', () => {
    expect(resolverFor([])('missing-tool')).toEqual({ kind: 'shell', file: 'missing-tool' });
  });

  it('uses an existing extensionless PATH binary directly', () => {
    const file = win.resolve('C:\\tools', 'custom');
    expect(resolverFor([file])('custom')).toEqual({ kind: 'direct', file });
  });

  it('classifies extensions case-insensitively', () => {
    const exe = win.resolve('C:\\tools', 'CLI.EXE');
    const cmd = win.resolve('C:\\tools', 'shim.Cmd');
    expect(resolverFor([exe], 'C:\\tools', '.EXE')('CLI')).toEqual({ kind: 'direct', file: exe });
    expect(resolverFor([cmd], 'C:\\tools', '.Cmd')('shim')).toEqual({ kind: 'shell', file: cmd });
  });

  it('removes quotes around PATH entries before searching them', () => {
    const file = win.resolve('C:\\Program Files\\Tools', 'claude.EXE');
    expect(resolverFor([file], '"C:\\Program Files\\Tools";C:\\other')('claude')).toEqual({ kind: 'direct', file });
  });
});
