import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveWindowsLaunch } from './win-binary-resolver';

// The resolver models Windows semantics via path.win32, so tests build their
// fixtures with path.win32 too and run identically on any host OS.
const win = path.win32;

function resolverFor(files: string[], pathEnv = 'C:\\tools', pathExt = '.COM;.EXE;.BAT;.CMD', shims: Record<string, string> = {}) {
  const known = new Set(files.map(file => win.normalize(file).toLowerCase()));
  return (binary: string) => resolveWindowsLaunch(binary, {
    pathEnv,
    pathExt,
    existsSync: candidate => known.has(win.normalize(candidate).toLowerCase()),
    readFileSync: candidate => {
      const shim = shims[win.normalize(candidate).toLowerCase()];
      if (shim === undefined) throw new Error('not a fixture');
      return shim;
    },
  });
}

const npmNodeShim = String.raw`@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\node.exe" (
  SET "_prog=%dp0%\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*`;

describe('resolveWindowsLaunch', () => {
  it('prefers the Windows npm shim over its extensionless Unix script', () => {
    const base = win.resolve('C:\\tools', 'codex');
    const file = `${base}.CMD`;
    const resolve = resolverFor([base, file, `${base}.ps1`]);
    expect(resolve('codex')).toEqual({ kind: 'shell', file });
    expect(resolve(base)).toEqual({ kind: 'shell', file });
  });

  it('does not append PATHEXT to an explicitly named file', () => {
    const file = win.resolve('C:\\tools', 'codex.cmd');
    expect(resolverFor([file, `${file}.EXE`])('codex.cmd')).toEqual({ kind: 'shell', file });
  });

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

  it('resolves an npm Node shim through a sibling node.exe', () => {
    const shim = win.resolve('C:\\tools', 'codex.CMD');
    const script = win.resolve('C:\\tools', 'node_modules\\@openai\\codex\\bin\\codex.js');
    const node = win.resolve('C:\\tools', 'node.exe');
    const resolve = resolverFor([shim, script, node], undefined, undefined, { [shim.toLowerCase()]: npmNodeShim });
    expect(resolve('codex')).toEqual({ kind: 'direct', file: node, args: [script] });
  });

  it('resolves an npm Node shim through node on PATH', () => {
    const shim = win.resolve('C:\\tools', 'codex.CMD');
    const script = win.resolve('C:\\tools', 'node_modules\\@openai\\codex\\bin\\codex.js');
    const node = win.resolve('C:\\node', 'node.EXE');
    const resolve = resolverFor([shim, script, node], 'C:\\tools;C:\\node', undefined, { [shim.toLowerCase()]: npmNodeShim });
    expect(resolve('codex')).toEqual({ kind: 'direct', file: node, args: [script] });
  });

  it('resolves a native executable shim directly', () => {
    const shim = win.resolve('C:\\tools', 'tool.CMD');
    const target = win.resolve('C:\\tools', 'bin\\tool.exe');
    const resolve = resolverFor([shim, target], undefined, undefined, {
      [shim.toLowerCase()]: String.raw`@ECHO off
"%~dp0%\bin\tool.exe" %*`,
    });
    expect(resolve('tool')).toEqual({ kind: 'direct', file: target });
  });

  it.each([
    ['an unrecognised wrapper', String.raw`@ECHO off
call "%~dp0%\tool.js" %*`, [win.resolve('C:\\tools', 'tool.CMD')]],
    ['a missing target', npmNodeShim, [win.resolve('C:\\tools', 'tool.CMD'), win.resolve('C:\\tools', 'node.exe')]],
  ])('falls back to the shell for %s', (_label, text, files) => {
    const shim = win.resolve('C:\\tools', 'tool.CMD');
    expect(resolverFor(files, undefined, undefined, { [shim.toLowerCase()]: text })('tool')).toEqual({ kind: 'shell', file: shim });
  });

  it('leaves .bat files and shims without node on PATH on the shell path', () => {
    const bat = win.resolve('C:\\tools', 'tool.BAT');
    expect(resolverFor([bat], 'C:\\tools', '.BAT', { [bat.toLowerCase()]: npmNodeShim })('tool'))
      .toEqual({ kind: 'shell', file: bat });

    const shim = win.resolve('C:\\tools', 'codex.CMD');
    const script = win.resolve('C:\\tools', 'node_modules\\@openai\\codex\\bin\\codex.js');
    expect(resolverFor([shim, script], undefined, undefined, { [shim.toLowerCase()]: npmNodeShim })('codex'))
      .toEqual({ kind: 'shell', file: shim });
  });
});
