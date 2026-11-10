import { existsSync as fileExistsSync, readFileSync as fileReadFileSync } from 'node:fs';
import path from 'node:path';

// This resolver models Windows command resolution, so it uses path.win32
// throughout — that keeps its behavior identical whether it runs on a Windows
// host (production) or a POSIX CI runner (tests). It is only ever invoked from
// the win32 launch path in the transports.
const win = path.win32;

export type WinLaunchPlan =
  | { kind: 'direct'; file: string; args?: string[] }
  | { kind: 'shell'; file: string };

export interface ResolveWindowsLaunchOptions {
  pathEnv?: string;
  pathExt?: string;
  existsSync?: (file: string) => boolean;
  readFileSync?: (file: string) => string;
}

const DEFAULT_PATH_EXT = '.COM;.EXE;.BAT;.CMD';

type ShimCommand =
  | { type: 'node'; target: string }
  | { type: 'native'; target: string };

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

function shimTextPrefix(text: string): string {
  let end = 0;
  for (const char of text) {
    const nextEnd = end + Buffer.byteLength(char);
    if (nextEnd > 4096) break;
    end = nextEnd;
  }
  return text.slice(0, end);
}

function resolveCmdShim(file: string, opts: ResolveWindowsLaunchOptions, existsSync: (file: string) => boolean): WinLaunchPlan {
  try {
    const text = shimTextPrefix((opts.readFileSync || (candidate => fileReadFileSync(candidate, 'utf8')))(file));
    const shimDir = win.dirname(file);
    const commandLines: ShimCommand[] = [];
    for (const line of text.split(/\r?\n/)) {
      // cmd-shim joins program, arguments and target with single spaces, so an
      // empty field leaves a run of them; accept any amount of whitespace.
      const nodeMatch = /"%_prog%"[ \t]+"%(?:~)?dp0%\\([^"\r\n]+)"[ \t]+%\*\s*$/i.exec(line);
      if (nodeMatch) {
        commandLines.push({ type: 'node', target: nodeMatch[1] });
        continue;
      }

      const nativeMatch = /^[ \t]*@?"%(?:~)?dp0%\\([^"\r\n]+\.exe)"[ \t]+%\*\s*$/i.exec(line);
      if (nativeMatch) commandLines.push({ type: 'native', target: nativeMatch[1] });
    }

    if (commandLines.length !== 1) return { kind: 'shell', file };
    const command = commandLines[0];
    if (win.isAbsolute(command.target)) return { kind: 'shell', file };
    const target = win.resolve(shimDir, command.target);
    if (!existsSync(target)) return { kind: 'shell', file };

    if (command.type === 'native') return { kind: 'direct', file: target };

    const siblingNode = win.resolve(shimDir, 'node.exe');
    if (existsSync(siblingNode)) {
      return { kind: 'direct', file: siblingNode, args: [target] };
    }

    const nodePlan = resolveWindowsLaunch('node', opts);
    return nodePlan.kind === 'direct' && nodePlan.args === undefined
      ? { kind: 'direct', file: nodePlan.file, args: [target] }
      : { kind: 'shell', file };
  } catch {
    return { kind: 'shell', file };
  }
}

function planForResolvedFile(file: string, opts: ResolveWindowsLaunchOptions, existsSync: (file: string) => boolean): WinLaunchPlan {
  const extension = win.extname(file).toLowerCase();
  if (extension === '.cmd') return resolveCmdShim(file, opts, existsSync);
  if (extension === '.bat') return { kind: 'shell', file };
  return { kind: 'direct', file };
}

/**
 * Resolve a Windows command name before handing it to node-pty. Native
 * executables can receive argv directly; batch shims require cmd.exe.
 */
export function resolveWindowsLaunch(binary: string, opts: ResolveWindowsLaunchOptions = {}): WinLaunchPlan {
  try {
    const existsSync = opts.existsSync || fileExistsSync;
    const extensions = pathExts(opts.pathExt ?? process.env.PATHEXT);
    const isExplicitPath = /[\\/]/.test(binary) || /^[A-Za-z]:/.test(binary);

    if (isExplicitPath) {
      const explicitFile = win.resolve(binary);
      if (win.extname(explicitFile)) {
        return existsSync(explicitFile)
          ? planForResolvedFile(explicitFile, opts, existsSync)
          : { kind: 'shell', file: binary };
      }

      // npm installs Unix shell scripts beside Windows .cmd shims. Prefer the
      // Windows candidates before considering an extensionless file.
      for (const extension of extensions) {
        const candidate = `${explicitFile}${extension}`;
        if (existsSync(candidate)) return planForResolvedFile(candidate, opts, existsSync);
      }
      if (existsSync(explicitFile)) return planForResolvedFile(explicitFile, opts, existsSync);
      return { kind: 'shell', file: binary };
    }

    const pathEntries = (opts.pathEnv ?? process.env.PATH ?? '')
      .split(win.delimiter)
      .map(entry => entry.trim().replace(/^"|"$/g, ''))
      .filter(Boolean);

    for (const directory of pathEntries) {
      for (const extension of win.extname(binary) ? [''] : [...extensions, '']) {
        const candidate = win.resolve(directory, `${binary}${extension}`);
        if (existsSync(candidate)) return planForResolvedFile(candidate, opts, existsSync);
      }
    }

    // Preserve cmd.exe's legacy PATH/PATHEXT fallback for commands we could not
    // resolve ourselves (including aliases supplied by a user's environment).
    return { kind: 'shell', file: binary };
  } catch {
    return { kind: 'shell', file: binary };
  }
}
