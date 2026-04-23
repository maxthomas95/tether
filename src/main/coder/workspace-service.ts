import { execFile } from 'node:child_process';
import { getEnvironment } from '../db/environment-repo';
import { createLogger } from '../logger';
import type { CoderWorkspace, CreateCoderWorkspaceOptions } from '../../shared/types';

const log = createLogger('coder-workspace');

/**
 * Resolves the `coder` binary path for a given Coder environment. Falls back
 * to `coder` on PATH when the env has no explicit `binaryPath`.
 */
export function resolveCoderBinary(environmentId: string): string {
  const env = getEnvironment(environmentId);
  if (env?.type !== 'coder') {
    throw new Error('Environment not found or not a Coder environment');
  }
  try {
    const cfg = JSON.parse(env.config) as Record<string, unknown>;
    if (typeof cfg.binaryPath === 'string' && cfg.binaryPath.trim()) {
      return cfg.binaryPath.trim();
    }
  } catch { /* use default */ }
  return 'coder';
}

/**
 * Runs `coder list --output json` for the given environment and returns the
 * parsed workspace summaries. Used by name-collision checks before calling
 * `createCoderWorkspace`.
 */
export async function listCoderWorkspaces(environmentId: string): Promise<CoderWorkspace[]> {
  const binaryPath = resolveCoderBinary(environmentId);
  return new Promise<CoderWorkspace[]>((resolve, reject) => {
    execFile(
      binaryPath,
      ['list', '--output', 'json'],
      { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          log.error('coder list failed', { error: err.message, stderr: String(stderr).slice(0, 500) });
          reject(new Error(stderr ? String(stderr).trim() : err.message));
          return;
        }
        try {
          const raw = JSON.parse(String(stdout || '[]')) as unknown;
          if (!Array.isArray(raw)) {
            resolve([]);
            return;
          }
          const workspaces: CoderWorkspace[] = raw.map((w: Record<string, unknown>) => {
            const latestBuild = (w.latest_build as Record<string, unknown> | undefined) || {};
            // Use typeof guards so non-string fields degrade to '' / 'unknown'
            // instead of being String()'d into '[object Object]'.
            const name = typeof w.name === 'string' ? w.name : '';
            const ownerSource = w.owner_name ?? w.owner;
            const owner = typeof ownerSource === 'string' ? ownerSource : '';
            const statusSource = latestBuild.status ?? w.status;
            const status = typeof statusSource === 'string' ? statusSource : 'unknown';
            return { name, owner, status };
          });
          resolve(workspaces);
        } catch (parseErr) {
          reject(new Error('Failed to parse coder list output: ' + (parseErr instanceof Error ? parseErr.message : String(parseErr))));
        }
      },
    );
  });
}

/**
 * Spawns `coder create <name> --template <template> --yes --parameter k=v ...`
 * under a PTY (required on Windows even when every parameter is supplied —
 * `coder create` writes interactive prompts to the console handle).
 *
 * The optional `onProgress` callback receives each progress-ish line scraped
 * out of stdout so a caller can surface streaming updates (IPC progress event,
 * log, etc.) without needing to duplicate the PTY plumbing.
 */
export async function createCoderWorkspace(
  opts: CreateCoderWorkspaceOptions,
  onProgress?: (line: string) => void,
): Promise<CoderWorkspace> {
  const binaryPath = resolveCoderBinary(opts.environmentId);
  log.info('Creating Coder workspace', { template: opts.templateName, name: opts.workspaceName });

  let ptyMod: typeof import('node-pty');
  try { ptyMod = require('node-pty'); } catch {
    throw new Error('node-pty not available — cannot create Coder workspace');
  }

  const args = ['create', opts.workspaceName, '--template', opts.templateName, '--yes',
    ...Object.entries(opts.parameters || {}).flatMap(([name, value]) => ['--parameter', `${name}=${value}`]),
  ];

  log.info('coder create via PTY', { bin: binaryPath, args });

  return new Promise<CoderWorkspace>((resolve, reject) => {
    const proc = ptyMod.spawn(binaryPath, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: process.cwd(),
      env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
    });

    let output = '';
    const progressRe = /==>|===|Planning|Initializing|Starting|Queued|Running|Setting up|Cleaning/;

    proc.onData((data: string) => {
      output += data;
      if (!onProgress) return;
      for (const line of data.split(/[\r\n]+/)) {
        const clean = line.replaceAll(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
        if (clean && progressRe.test(clean)) {
          onProgress(clean);
        }
      }
    });

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error('Workspace creation timed out after 5 minutes'));
    }, 300_000);

    proc.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      if (exitCode !== 0) {
        const lines = output.replaceAll(/\x1b\[[0-9;]*[a-zA-Z]/g, '').split(/[\r\n]+/).filter(l => l.trim());
        const errLine = lines.findLast(l => /error:|failed/i.test(l)) || lines[0] || `exit code ${exitCode}`;
        log.error('coder create failed', { exitCode, error: errLine });
        reject(new Error(errLine));
        return;
      }
      log.info('Coder workspace created', { name: opts.workspaceName });
      resolve({
        name: opts.workspaceName,
        owner: 'me',
        status: 'starting',
      });
    });
  });
}
