import { spawn } from 'node:child_process';
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
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
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
