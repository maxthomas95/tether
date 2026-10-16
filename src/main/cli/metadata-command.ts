import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import type { MaintainableCliTool } from '../../shared/cli-tools';
import { resolveCliExecutable, resolveWindowsSystemExecutable } from './executable-resolver';

export type CliMetadataResult =
  | { ok: true; stdout: string }
  | { ok: false; reason: 'unavailable' | 'failed' | 'timeout' | 'too-large' };

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

function metadataEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (process.platform === 'win32') {
      for (const inheritedKey of Object.keys(env)) {
        if (inheritedKey.toLowerCase() === key.toLowerCase()) delete env[inheritedKey];
      }
    }
    env[key] = value;
  }
  return env;
}

function environmentValue(env: NodeJS.ProcessEnv, name: string): string {
  const key = process.platform === 'win32'
    ? Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase())
    : name;
  return (key === undefined ? undefined : env[key]) ?? '';
}

function metadataWorkingDirectory(input: string): string {
  if (typeof input !== 'string' || input.length === 0 || /[\0\r\n]/.test(input)) {
    throw new Error('Invalid metadata working directory');
  }
  const paths = process.platform === 'win32' ? path.win32 : path.posix;
  if (!paths.isAbsolute(input)) throw new Error('Metadata working directory must be absolute');
  const normalized = paths.normalize(input);
  if (process.platform === 'win32' && paths.parse(normalized).root === '\\') {
    throw new Error('Metadata working directory must be drive-qualified or UNC');
  }
  // The user selects this local project, including directories outside the app.
  // Validate the directory itself rather than confining it to an app-owned root.
  // stat follows directory symlinks and supports Windows extended-length paths.
  const resolved = paths.resolve(normalized);
  if (!statSync(resolved).isDirectory()) throw new Error('Metadata working directory must be a folder');
  return resolved;
}

function stopMetadataProcess(proc: ReturnType<typeof spawn>): void {
  let killedDirectly = false;
  const killDirectly = () => {
    if (killedDirectly) return;
    killedDirectly = true;
    try { proc.kill(); } catch { /* already gone */ }
  };

  if (process.platform === 'win32' && proc.pid) {
    try {
      const taskkill = resolveWindowsSystemExecutable('taskkill.exe');
      if (taskkill) {
        const cleanup = spawn(taskkill, ['/pid', String(proc.pid), '/t', '/f'], {
          windowsHide: true, shell: false, stdio: 'ignore',
        });
        cleanup.on('error', killDirectly);
        cleanup.on('exit', code => { if (code !== 0) killDirectly(); });
        return;
      }
    } catch { /* fall back to the direct child */ }
  }
  killDirectly();
}

/** Run a bounded, non-interactive metadata command, separate from session PTYs. */
export async function runCliMetadata(
  tool: MaintainableCliTool,
  args: readonly string[],
  options: { timeoutMs?: number; maxBytes?: number; env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<CliMetadataResult> {
  return new Promise(resolve => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const chunks: Buffer[] = [];
    const finish = (result: CliMetadataResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chunks.length = 0;
      resolve(result);
    };

    let proc: ReturnType<typeof spawn>;
    try {
      const cwd = options.cwd === undefined ? undefined : metadataWorkingDirectory(options.cwd);
      const env = metadataEnvironment(options.env);
      const launch = resolveCliExecutable(tool, {
        args,
        pathEnv: environmentValue(env, 'PATH'),
        pathExt: environmentValue(env, 'PATHEXT'),
        comSpec: environmentValue(env, 'ComSpec'),
        systemRoot: environmentValue(env, 'SystemRoot'),
      });
      if (!launch) { finish({ ok: false, reason: 'unavailable' }); return; }
      proc = spawn(launch.file, launch.args, {
        windowsHide: true,
        windowsVerbatimArguments: launch.kind === 'cmd',
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
        ...(cwd === undefined ? {} : { cwd }),
      });
    } catch {
      finish({ ok: false, reason: 'failed' });
      return;
    }

    const fail = (reason: 'failed' | 'timeout' | 'too-large') => {
      if (settled) return;
      finish({ ok: false, reason });
      stopMetadataProcess(proc);
    };

    timer = setTimeout(() => fail('timeout'), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    proc.on('error', () => fail('failed'));
    proc.on('close', code => {
      if (settled) return;
      if (code !== 0) { finish({ ok: false, reason: 'failed' }); return; }
      // Decode once so UTF-8 code points split between chunks remain intact.
      finish({ ok: true, stdout: Buffer.concat(chunks).toString('utf-8') });
    });

    let stdoutBytes = 0;
    proc.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > (options.maxBytes ?? DEFAULT_MAX_BYTES)) {
        fail('too-large');
        return;
      }
      chunks.push(chunk);
    });
    proc.stdout?.on('error', () => fail('failed'));
    proc.stderr?.on('error', () => fail('failed'));
    // Drain banners and diagnostics without retaining or logging their contents.
    proc.stderr?.resume();
  });
}
