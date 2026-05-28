import { describe, expect, it } from 'vitest';
import {
  assertSafeCmdExeCommand,
  escapeCmdExeArgForNodePty,
  quoteCmdExeArg,
  quotePosixEnvAssignment,
  quotePosixPathPreservingHome,
  quotePosixShellArg,
  quoteShellArg,
} from './shell-quote';

describe('shell quote helpers', () => {
  it('single-quotes POSIX shell args and preserves embedded single quotes', () => {
    expect(quotePosixShellArg("it's $weird; rm -rf /")).toBe(String.raw`'it'\''s $weird; rm -rf /'`);
  });

  it('quotes an empty POSIX arg', () => {
    expect(quotePosixShellArg('')).toBe("''");
  });

  it('quotes POSIX env assignments as one argv word for env(1)', () => {
    expect(quotePosixEnvAssignment('TRICKY', "it's $weird")).toBe(String.raw`'TRICKY=it'\''s $weird'`);
  });

  it('rejects invalid POSIX env assignment names', () => {
    expect(() => quotePosixEnvAssignment('BAD=NAME', 'value')).toThrow(/cannot contain/);
  });

  it('preserves leading tilde expansion while quoting the rest of a POSIX path', () => {
    expect(quotePosixPathPreservingHome('~/code/my repo')).toBe("~/'code/my repo'");
    expect(quotePosixPathPreservingHome('/opt/my repo')).toBe("'/opt/my repo'");
  });

  it('quotes cmd.exe args without escaping Windows path backslashes', () => {
    expect(quoteCmdExeArg(String.raw`C:\Program Files\Tether\hook.js`)).toBe(String.raw`"C:\Program Files\Tether\hook.js"`);
  });

  it('escapes cmd.exe percent and caret metacharacters without touching backslashes', () => {
    expect(quoteCmdExeArg(String.raw`C:\%APP_HOME%\^hook.js`)).toBe(String.raw`"C:\^%APP_HOME^%\^^hook.js"`);
  });

  it('rejects cmd.exe args with double quotes', () => {
    expect(() => quoteCmdExeArg(String.raw`C:\bad"path\hook.js`)).toThrow(/double quotes/);
  });

  it('escapes cmd.exe argv values for node-pty without forcing quotes', () => {
    expect(escapeCmdExeArgForNodePty('percent%PATH%')).toBe('percent^%PATH^%');
    expect(escapeCmdExeArgForNodePty('caret^x')).toBe('caret^^x');
    expect(escapeCmdExeArgForNodePty('fix&calc')).toBe('fix^&calc');
  });

  it('does not caret-escape ampersands inside whitespace args that node-pty quotes', () => {
    expect(escapeCmdExeArgForNodePty('fix & explain')).toBe('fix & explain');
  });

  it('rejects unsafe cmd.exe command-position values', () => {
    expect(() => assertSafeCmdExeCommand('claude&calc', 'CLI binary')).toThrow(/unsafe/);
    expect(() => assertSafeCmdExeCommand('claude%PATH%', 'CLI binary')).toThrow(/unsafe/);
    expect(() => assertSafeCmdExeCommand('claude')).not.toThrow();
  });

  it('selects platform-specific quoting when requested', () => {
    expect(quoteShellArg(String.raw`C:\Program Files\Tether\hook.js`, 'win32')).toBe(String.raw`"C:\Program Files\Tether\hook.js"`);
    expect(quoteShellArg('/opt/Tether hook.js', 'posix')).toBe("'/opt/Tether hook.js'");
  });
});
