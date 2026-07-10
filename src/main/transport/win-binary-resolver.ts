import { existsSync as fileExistsSync } from 'node:fs';
import path from 'node:path';

export type WinLaunchPlan =
  | { kind: 'direct'; file: string }
  | { kind: 'shell'; file: string };

export interface ResolveWindowsLaunchOptions {
  pathEnv?: string;
  pathExt?: string;
  existsSync?: (file: string) => boolean;
}

const DEFAULT_PATH_EXT = '.COM;.EXE;.BAT;.CMD';

// An appended extension keeps the casing PATHEXT declares it with; explicit
// paths keep the user's casing. Windows' filesystem match is case-insensitive
// either way, so this only affects the cosmetic casing of the resolved path.
function pathExts(pathExt: string | undefined): string[] {
  return (pathExt || DEFAULT_PATH_EXT)
    .split(';')
    .map(extension => extension.trim())
    .filter(Boolean)
    .map(extension => extension.startsWith('.') ? extension : `.${extension}`);
}

function planForResolvedFile(file: string): WinLaunchPlan {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.cmd' || extension === '.bat') {
    return { kind: 'shell', file };
  }
  return { kind: 'direct', file };
}

/**
 * Resolve a Windows command name before handing it to node-pty. Native
 * executables can receive argv directly; batch shims require cmd.exe.
 */
export function resolveWindowsLaunch(binary: string, opts: ResolveWindowsLaunchOptions = {}): WinLaunchPlan {
  const existsSync = opts.existsSync || fileExistsSync;
  const extensions = pathExts(opts.pathExt ?? process.env.PATHEXT);
  const isExplicitPath = /[\\/]/.test(binary) || /^[A-Za-z]:/.test(binary);

  if (isExplicitPath) {
    const explicitFile = path.resolve(binary);
    if (path.extname(explicitFile)) {
      return existsSync(explicitFile)
        ? planForResolvedFile(explicitFile)
        : { kind: 'shell', file: binary };
    }

    for (const extension of extensions) {
      const candidate = `${explicitFile}${extension}`;
      if (existsSync(candidate)) return planForResolvedFile(candidate);
    }
    return { kind: 'shell', file: binary };
  }

  const pathEntries = (opts.pathEnv ?? process.env.PATH ?? '')
    .split(path.delimiter)
    .map(entry => entry.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);

  for (const directory of pathEntries) {
    for (const extension of ['', ...extensions]) {
      const candidate = path.resolve(directory, `${binary}${extension}`);
      if (existsSync(candidate)) return planForResolvedFile(candidate);
    }
  }

  // Preserve cmd.exe's legacy PATH/PATHEXT fallback for commands we could not
  // resolve ourselves (including aliases supplied by a user's environment).
  return { kind: 'shell', file: binary };
}
