import { existsSync as fileExistsSync } from 'node:fs';
import path from 'node:path';
import { quoteCmdExeArg } from '../../shared/shell-quote';

export type CodexExecutableLaunch =
  | { kind: 'direct'; file: string; args: string[] }
  | { kind: 'cmd'; file: string; args: string[] };

export interface ResolveCodexExecutableOptions {
  platform?: NodeJS.Platform;
  pathEnv?: string;
  pathExt?: string;
  comSpec?: string;
  systemRoot?: string;
  existsSync?: (file: string) => boolean;
}

const DEFAULT_WINDOWS_EXTS = ['.EXE', '.CMD', '.BAT', '.COM'];
const WINDOWS_DIRECT_EXTS = new Set(['.exe', '.com']);
const WINDOWS_SHIM_EXTS = new Set(['.cmd', '.bat']);

export function resolveCodexExecutable(opts: ResolveCodexExecutableOptions = {}): CodexExecutableLaunch | null {
  const platform = opts.platform ?? process.platform;
  return platform === 'win32' ? resolveWindowsCodex(opts) : resolvePosixCodex(opts);
}

export function resolveWindowsSystemExecutable(
  name: 'cmd.exe' | 'taskkill.exe',
  opts: ResolveCodexExecutableOptions = {},
): string {
  const existsSync = opts.existsSync ?? fileExistsSync;
  const comSpec = opts.comSpec ?? process.env.ComSpec;
  if (name === 'cmd.exe' && comSpec && isTrustedWindowsAbsolutePath(comSpec) && path.win32.basename(comSpec).toLowerCase() === 'cmd.exe' && existsSync(comSpec)) {
    return path.win32.resolve(comSpec);
  }

  const systemRoot = opts.systemRoot ?? process.env.SystemRoot;
  if (systemRoot && isTrustedWindowsAbsolutePath(systemRoot)) {
    const candidate = path.win32.join(systemRoot, 'System32', name);
    if (existsSync(candidate)) return candidate;
  }

  return name;
}

function resolveWindowsCodex(opts: ResolveCodexExecutableOptions): CodexExecutableLaunch | null {
  const existsSync = opts.existsSync ?? fileExistsSync;
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? '';
  const extensions = windowsPathExts(opts.pathExt ?? process.env.PATHEXT);
  const pathEntries = pathEnv
    .split(path.win32.delimiter)
    .map(entry => entry.trim().replace(/^"|"$/g, ''))
    .filter(isTrustedWindowsAbsolutePath);

  const executableCandidates: string[] = [];
  const shimCandidates: string[] = [];
  for (const directory of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.win32.resolve(directory, `codex${extension}`);
      const extensionLower = path.win32.extname(candidate).toLowerCase();
      if (WINDOWS_DIRECT_EXTS.has(extensionLower)) {
        executableCandidates.push(candidate);
      } else if (WINDOWS_SHIM_EXTS.has(extensionLower)) {
        shimCandidates.push(candidate);
      }
    }
  }

  for (const candidate of executableCandidates) {
    if (existsSync(candidate)) return { kind: 'direct', file: candidate, args: ['app-server'] };
  }

  for (const candidate of shimCandidates) {
    if (existsSync(candidate)) {
      const cmd = resolveWindowsSystemExecutable('cmd.exe', opts);
      return { kind: 'cmd', file: cmd, args: ['/d', '/s', '/c', `${quoteCmdExeArg(candidate)} app-server`] };
    }
  }

  return null;
}

function resolvePosixCodex(opts: ResolveCodexExecutableOptions): CodexExecutableLaunch | null {
  const existsSync = opts.existsSync ?? fileExistsSync;
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? '';
  const pathEntries = pathEnv
    .split(':')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0 && path.posix.isAbsolute(entry));

  for (const directory of pathEntries) {
    const candidate = path.posix.resolve(directory, 'codex');
    if (existsSync(candidate)) return { kind: 'direct', file: candidate, args: ['app-server'] };
  }

  return null;
}

function windowsPathExts(pathExt: string | undefined): string[] {
  const extensions = (pathExt || DEFAULT_WINDOWS_EXTS.join(';'))
    .split(';')
    .map(extension => extension.trim())
    .filter(Boolean)
    .map(extension => extension.startsWith('.') ? extension : `.${extension}`);
  return extensions.length > 0 ? extensions : DEFAULT_WINDOWS_EXTS;
}

function isTrustedWindowsAbsolutePath(value: string): boolean {
  if (value.length === 0) return false;
  if (value.startsWith('\\\\?\\') || value.startsWith('\\\\.\\')) return false;
  return path.win32.isAbsolute(value);
}
