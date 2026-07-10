/**
 * Shell quoting helpers for places where Tether has to cross a real shell
 * boundary. Prefer argv/env APIs instead when a transport offers them.
 */

export type ShellPlatform = 'win32' | 'posix';

const POSIX_SINGLE_QUOTE_ESCAPE = String.raw`'\''`;
const POSIX_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CMD_EXE_COMMAND_META_RE = /[&|<>()^%!]/;
const CMD_EXE_ARG_META_RE = /[&|<>()]/;

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
  if (!POSIX_ENV_NAME_RE.test(name)) {
    throw new Error(`Invalid environment variable name: ${name}; names must match ${POSIX_ENV_NAME_RE} and cannot contain "="`);
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

function assertNoCmdLineBreak(value: string, label: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`${label} cannot contain line breaks`);
  }
}

/**
 * node-pty's Windows cmd.exe wrapper passes argv entries separately, but cmd.exe
 * still expands `%VAR%` and consumes bare carets before the target process sees
 * them. Escape only the characters that need escaping in argv positions; other
 * metacharacters are escaped only when the value has no whitespace, where
 * node-pty will not quote the value for us.
 */
export function escapeCmdExeArgForNodePty(value: string): string {
  assertNoNul(value, 'cmd.exe argument');
  assertNoCmdLineBreak(value, 'cmd.exe argument');
  if (value.includes('"')) {
    throw new Error('cmd.exe arguments with double quotes are not supported here');
  }

  let out = '';
  for (const ch of value) {
    if (ch === '^') {
      out += '^^';
    } else if (ch === '%') {
      out += '^%';
    } else if (CMD_EXE_ARG_META_RE.test(ch)) {
      out += `^${ch}`;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * The first argv entry after `cmd.exe /c` is parsed as the command name. Do not
 * allow cmd metacharacters there; keep using node-pty's own quoting for spaces
 * in ordinary executable paths.
 */
export function assertSafeCmdExeCommand(value: string, label = 'cmd.exe command'): void {
  assertNoNul(value, label);
  assertNoCmdLineBreak(value, label);
  if (value.includes('"') || CMD_EXE_COMMAND_META_RE.test(value)) {
    throw new Error(`${label} contains characters that are unsafe for cmd.exe`);
  }
}

export function quoteShellArg(value: string, platform: ShellPlatform = process.platform === 'win32' ? 'win32' : 'posix'): string {
  return platform === 'win32' ? quoteCmdExeArg(value) : quotePosixShellArg(value);
}
