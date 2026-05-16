import { describe, expect, it } from 'vitest';
import {
  quoteCmdExeArg,
  quotePosixEnvAssignment,
  quotePosixPathPreservingHome,
  quotePosixShellArg,
  quoteShellArg,
} from './shell-quote';

describe('shell quote helpers', () => {
  it('single-quotes POSIX shell args and preserves embedded single quotes', () => {
    expect(quotePosixShellArg("it's $weird; rm -rf /")).toBe("'it'\\''s $weird; rm -rf /'");
  });

  it('quotes an empty POSIX arg', () => {
    expect(quotePosixShellArg('')).toBe("''");
  });

  it('quotes POSIX env assignments as one argv word for env(1)', () => {
    expect(quotePosixEnvAssignment('TRICKY', "it's $weird")).toBe("'TRICKY=it'\\''s $weird'");
  });

  it('rejects invalid POSIX env assignment names', () => {
    expect(() => quotePosixEnvAssignment('BAD=NAME', 'value')).toThrow(/cannot contain/);
  });

  it('preserves leading tilde expansion while quoting the rest of a POSIX path', () => {
    expect(quotePosixPathPreservingHome('~/code/my repo')).toBe("~/'code/my repo'");
    expect(quotePosixPathPreservingHome('/tmp/my repo')).toBe("'/tmp/my repo'");
  });

  it('quotes cmd.exe args without escaping Windows path backslashes', () => {
    expect(quoteCmdExeArg('C:\\Program Files\\Tether\\hook.js')).toBe('"C:\\Program Files\\Tether\\hook.js"');
  });

  it('escapes cmd.exe percent and caret metacharacters without touching backslashes', () => {
    expect(quoteCmdExeArg('C:\\%APP_HOME%\\^hook.js')).toBe('"C:\\^%APP_HOME^%\\^^hook.js"');
  });

  it('rejects cmd.exe args with double quotes', () => {
    expect(() => quoteCmdExeArg('C:\\bad"path\\hook.js')).toThrow(/double quotes/);
  });

  it('selects platform-specific quoting when requested', () => {
    expect(quoteShellArg('C:\\Program Files\\Tether\\hook.js', 'win32')).toBe('"C:\\Program Files\\Tether\\hook.js"');
    expect(quoteShellArg('/opt/Tether hook.js', 'posix')).toBe("'/opt/Tether hook.js'");
  });
});
