import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

/** Resolve a working standalone Node binary; Electron's executable is not a Node launcher. */
export async function resolveHookNodePath(pathValue = process.env.PATH): Promise<string | null> {
  const names = process.platform === 'win32' ? ['node.exe'] : ['node', 'nodejs'];
  for (const entry of (pathValue ?? '').split(path.delimiter)) {
    const directory = entry.trim().replace(/^"(.*)"$/, '$1');
    // Do not pick up a binary from the app's current working directory.
    if (!path.isAbsolute(directory)) continue;
    for (const name of names) {
      const executable = path.join(directory, name);
      try { await fs.promises.access(executable, fs.constants.X_OK); } catch { continue; }
      const works = await new Promise<boolean>(resolve => {
        execFile(executable, ['--version'], { timeout: 3_000, maxBuffer: 1024, windowsHide: true }, (error, stdout) => {
          resolve(!error && /^v\d+\.\d+\.\d+\s*$/.test(stdout));
        });
      });
      if (works) return executable;
    }
  }
  return null;
}
