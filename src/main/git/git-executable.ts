import fs from 'node:fs';
import path from 'node:path';

function absolutePathEntry(entry: string): string | null {
  const trimmed = entry.trim();
  const directory = trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1) : trimmed;
  if (!directory) return null;
  const paths = process.platform === 'win32' ? path.win32 : path.posix;
  const normalized = paths.normalize(directory);
  if (!paths.isAbsolute(normalized)) return null;
  if (process.platform === 'win32' && (
    (normalized.startsWith('\\') && !normalized.startsWith('\\\\')) ||
    normalized.startsWith('\\\\?\\') || normalized.startsWith('\\\\.\\')
  )) return null;
  return normalized;
}

/**
 * Trust the app's inherited absolute PATH entries, never the repository cwd.
 * Passing an absolute executable prevents Windows' implicit cwd search from
 * running a repository's git.exe. Relative/empty PATH entries and batch shims
 * are deliberately unsupported; no command is executed during discovery.
 */
export function resolveGitExecutable(): string {
  const windows = process.platform === 'win32';
  const paths = windows ? path.win32 : path.posix;
  for (const entry of (process.env.PATH ?? '').split(paths.delimiter)) {
    const directory = absolutePathEntry(entry);
    if (!directory) continue;
    const candidate = paths.join(directory, windows ? 'git.exe' : 'git');
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, windows ? fs.constants.F_OK : fs.constants.X_OK);
      return candidate;
    } catch {
      // Missing, inaccessible, or non-executable entries are not candidates.
    }
  }
  throw new Error('Git executable not found in an absolute PATH directory');
}
