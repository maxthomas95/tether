import { spawn } from 'node:child_process';
import path from 'node:path';
import type { TranscriptInfo } from '../../shared/types';
import { createLogger } from '../logger';
import { resolveCliExecutable, resolveWindowsSystemExecutable } from '../cli/executable-resolver';

const log = createLogger('opencode-transcripts');
const MAX_SESSION_LIST_BYTES = 4 * 1024 * 1024;

interface OpencodeSessionRow {
  id: string;
  title?: string;
  updated?: number;
  created?: number;
  projectId?: string;
  directory?: string;
}

function normalizeCwd(cwd: string): string {
  const resolved = path.resolve(cwd);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function truncatePreview(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
}

function isSessionRow(value: unknown): value is OpencodeSessionRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === 'string' && row.id.length > 0
    && typeof row.directory === 'string' && row.directory.length > 0
    && !row.directory.includes('\0');
}

function stopSessionList(proc: ReturnType<typeof spawn>): void {
  if (process.platform === 'win32' && proc.pid) {
    const taskkill = resolveWindowsSystemExecutable('taskkill.exe');
    if (taskkill) {
      try {
        const cleanup = spawn(taskkill, ['/pid', String(proc.pid), '/t', '/f'], {
          windowsHide: true, shell: false, stdio: 'ignore',
        });
        cleanup.on('error', () => { try { proc.kill(); } catch { /* already gone */ } });
        cleanup.on('exit', code => {
          if (code !== 0) { try { proc.kill(); } catch { /* already gone */ } }
        });
        return;
      } catch { /* fall back to the direct child */ }
    }
  }
  try { proc.kill(); } catch { /* already gone */ }
}

/**
 * Run `opencode session list --format json` and parse the array. We shell out
 * because opencode 1.x migrated session storage to SQLite (`opencode.db`) and
 * the CLI is the only stable interface — reading the DB directly would couple
 * us to its private schema. The CLI is fast (single-shot, no daemon required).
 *
 * Returns null on spawn failure (binary missing, etc.) so callers can degrade
 * to "no transcripts" without surfacing an error.
 */
async function runSessionList(timeoutMs = 5000): Promise<OpencodeSessionRow[] | null> {
  return new Promise((resolve) => {
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: OpencodeSessionRow[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve(value);
    };

    let proc: ReturnType<typeof spawn>;
    try {
      const launch = resolveCliExecutable('opencode', { args: ['session', 'list', '--format', 'json'] });
      if (!launch) { finish(null); return; }
      proc = spawn(launch.file, launch.args, {
        windowsHide: true,
        windowsVerbatimArguments: launch.kind === 'cmd',
        shell: false,
        // This metadata command is separate from every session's PTY.
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      log.warn('Failed to spawn opencode', { error: err instanceof Error ? err.message : String(err) });
      finish(null);
      return;
    }

    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    proc.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_SESSION_LIST_BYTES) {
        log.warn('opencode session list exceeded the response limit');
        finish(null);
        stopSessionList(proc);
        return;
      }
      chunks.push(chunk);
    });
    proc.stderr?.on('data', () => { /* ignore — opencode prints non-JSON banners */ });

    killTimer = setTimeout(() => {
      log.warn('opencode session list timed out');
      finish(null);
      stopSessionList(proc);
    }, timeoutMs);

    proc.on('error', (err) => {
      if (settled) return;
      log.warn('opencode session list errored', { error: err.message });
      finish(null);
    });

    proc.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        finish([]);
        return;
      }
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        if (!Array.isArray(parsed)) {
          finish([]);
          return;
        }
        finish(parsed.filter(isSessionRow));
      } catch {
        // Parse errors can include transcript excerpts; never log the payload.
        log.warn('opencode session list returned unparseable JSON');
        finish([]);
      }
    });
  });
}

function rowToTranscript(row: OpencodeSessionRow): TranscriptInfo | null {
  if (!row.id) return null;
  const ts = row.updated ?? row.created;
  const mtime = typeof ts === 'number' && Number.isFinite(new Date(ts).getTime())
    ? new Date(ts).toISOString()
    : new Date(0).toISOString();
  return {
    id: row.id,
    mtime,
    preview: truncatePreview(typeof row.title === 'string' ? row.title : ''),
    cliTool: 'opencode',
    sourcePath: row.directory,
  };
}

/**
 * List opencode transcripts whose `directory` matches the given cwd, newest
 * first. Returns at most `limit` results. Returns `[]` on any spawn / parse
 * failure — opencode is optional, missing it shouldn't break the picker.
 */
export async function listOpencodeTranscripts(cwd: string, limit = 50): Promise<TranscriptInfo[]> {
  const rows = await runSessionList();
  if (!rows) return [];
  const target = normalizeCwd(cwd);
  const matches: TranscriptInfo[] = [];
  for (const row of rows) {
    if (!row.directory) continue;
    if (normalizeCwd(row.directory) !== target) continue;
    const t = rowToTranscript(row);
    if (t) matches.push(t);
  }
  matches.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return matches.slice(0, limit);
}

export async function opencodeTranscriptExists(cwd: string, sessionId: string): Promise<boolean> {
  const rows = await runSessionList();
  if (!rows) return false;
  const target = normalizeCwd(cwd);
  return rows.some(r => r.id === sessionId && r.directory && normalizeCwd(r.directory) === target);
}
