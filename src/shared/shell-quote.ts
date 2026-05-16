/**
 * Shell quoting helpers for places where Tether has to cross a real shell
 * boundary. Prefer argv/env APIs instead when a transport offers them.
 */

export type ShellPlatform = 'win32' | 'posix';

const POSIX_SINGLE_QUOTE_ESCAPE = String.raw`'\''`;

function assertNoNul(value: string, label: string): void {
  if (value.includes('\0')) {
    throw new Error(`${label} cannot contain NUL bytes`);
  }
}

export function quotePosixShellArg(value: string): string {
  assertNoNul(value, 'POSIX shell argument');

  let out = "'";
  for (const ch of value) {
    out += ch === "'" ? POSIX_SINGLE_QUOTE_ESCAPE : ch;
  }
  return out + "'";
}

export function quotePosixEnvAssignment(name: string, value: string): string {
  assertNoNul(name, 'Environment variable name');
  assertNoNul(value, 'Environment variable value');
  if (name.includes('=')) {
    throw new Error('Environment variable names cannot contain "="');
  }
  return quotePosixShellArg(`${name}=${value}`);
}

export function quotePosixPathPreservingHome(value: string): string {
  if (value === '~') return '~';
  if (value.startsWith('~/')) return '~/' + quotePosixShellArg(value.slice(2));
  return quotePosixShellArg(value);
}

export function quoteCmdExeArg(value: string): string {
  assertNoNul(value, 'cmd.exe argument');
  if (value.includes('"')) {
    throw new Error('cmd.exe arguments with double quotes are not supported here');
  }

  let out = '"';
  for (const ch of value) {
    if (ch === '^') {
      out += '^^';
    } else if (ch === '%') {
      out += '^%';
    } else {
      out += ch;
    }
  }
  return out + '"';
}

export function quoteShellArg(value: string, platform: ShellPlatform = process.platform === 'win32' ? 'win32' : 'posix'): string {
  return platform === 'win32' ? quoteCmdExeArg(value) : quotePosixShellArg(value);
}
