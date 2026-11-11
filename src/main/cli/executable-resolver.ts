import { existsSync as fileExistsSync } from 'node:fs';
import path from 'node:path';
import { quoteCmdExeArg } from '../../shared/shell-quote';
import { CLI_TOOL_REGISTRY, type MaintainableCliTool } from '../../shared/cli-tools';

export type CliExecutableLaunch =
  | { kind: 'direct'; file: string; args: string[] }
  | { kind: 'cmd'; file: string; args: string[] };

export interface ResolveCliExecutableOptions {
  args?: readonly string[];
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

export function resolveCliExecutable(tool: MaintainableCliTool, opts: ResolveCliExecutableOptions = {}): CliExecutableLaunch | null {
  const binary = CLI_TOOL_REGISTRY[tool].binaryName;
  const platform = opts.platform ?? process.platform;
  return platform === 'win32' ? resolveWindowsCli(binary, opts) : resolvePosixCli(binary, opts);
}

export function resolveWindowsSystemExecutable(
  name: 'cmd.exe' | 'taskkill.exe',
  opts: ResolveCliExecutableOptions = {},
): string | null {
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

  return null;
}

function resolveWindowsCli(binary: string, opts: ResolveCliExecutableOptions): CliExecutableLaunch | null {
  const existsSync = opts.existsSync ?? fileExistsSync;
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? '';
  const extensions = windowsPathExts(opts.pathExt ?? process.env.PATHEXT);
  const pathEntries = pathEnv
    .split(path.win32.delimiter)
    .map(entry => entry.trim().replace(/^"|"$/g, ''))
    .filter(isTrustedWindowsAbsolutePath);

  const candidates = pathEntries.flatMap(directory =>
    extensions.map(extension => path.win32.resolve(directory, `${binary}${extension}`)));
  const withExtensionIn = (allowed: ReadonlySet<string>) =>
    candidates.filter(candidate => allowed.has(path.win32.extname(candidate).toLowerCase()));

  const executable = withExtensionIn(WINDOWS_DIRECT_EXTS).find(candidate => existsSync(candidate));
  if (executable) return { kind: 'direct', file: executable, args: [...(opts.args ?? [])] };

  // These characters can expand inside cmd.exe quotes. Native paths do
  // not cross a shell and have no such restriction.
  const shim = withExtensionIn(WINDOWS_SHIM_EXTS)
    .find(candidate => existsSync(candidate) && !/[%^!"\r\n\0]/.test(candidate));
  if (!shim) return null;
  const cmd = resolveWindowsSystemExecutable('cmd.exe', opts);
  if (!cmd) return null;
  const args = (opts.args ?? []).map(quoteCmdExeArg).join(' ');
  return { kind: 'cmd', file: cmd, args: ['/d', '/v:off', '/s', '/c', `"${quoteCmdExeArg(shim)} ${args}"`] };
}

function resolvePosixCli(binary: string, opts: ResolveCliExecutableOptions): CliExecutableLaunch | null {
  const existsSync = opts.existsSync ?? fileExistsSync;
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? '';
  const pathEntries = pathEnv
    .split(':')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0 && path.posix.isAbsolute(entry));

  for (const directory of pathEntries) {
    const candidate = path.posix.resolve(directory, binary);
    if (existsSync(candidate)) return { kind: 'direct', file: candidate, args: [...(opts.args ?? [])] };
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
  if (value.length === 0 || /[\r\n\0"]/.test(value)) return false;
  const normalized = path.win32.normalize(value);
  if (normalized.startsWith('\\\\?\\') || normalized.startsWith('\\\\.\\')) return false;
  if (normalized.startsWith('\\') && !normalized.startsWith('\\\\')) return false;
  return path.win32.isAbsolute(normalized);
}
