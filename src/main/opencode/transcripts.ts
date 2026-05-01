import { spawn } from 'node:child_process';
import path from 'node:path';
import type { TranscriptInfo } from '../../shared/types';
import { createLogger } from '../logger';

const log = createLogger('opencode-transcripts');

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
    const finish = (value: OpencodeSessionRow[] | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn('opencode', ['session', 'list', '--format', 'json'], {
        windowsHide: true,
        // Detach from any tty so we don't accidentally feed signals to the user's shell.
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      log.warn('Failed to spawn opencode', { error: err instanceof Error ? err.message : String(err) });
      finish(null);
      return;
    }

    let stdout = '';
    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8'); });
    proc.stderr?.on('data', () => { /* ignore — opencode prints non-JSON banners */ });

    const killTimer = setTimeout(() => {
      try { proc.kill(); } catch { /* ignore */ }
      log.warn('opencode session list timed out');
      finish(null);
    }, timeoutMs);

    proc.on('error', (err) => {
      clearTimeout(killTimer);
      log.warn('opencode session list errored', { error: err.message });
      finish(null);
    });

    proc.on('close', (code) => {
      clearTimeout(killTimer);
      if (code !== 0) {
        finish([]);
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        if (!Array.isArray(parsed)) {
          finish([]);
          return;
        }
        finish(parsed as OpencodeSessionRow[]);
      } catch (err) {
        log.warn('opencode session list returned unparseable JSON', { error: err instanceof Error ? err.message : String(err) });
        finish([]);
      }
    });
  });
}

function rowToTranscript(row: OpencodeSessionRow): TranscriptInfo | null {
  if (!row.id) return null;
  const ts = row.updated ?? row.created;
  const mtime = typeof ts === 'number' && Number.isFinite(ts)
    ? new Date(ts).toISOString()
    : new Date(0).toISOString();
  return {
    id: row.id,
    mtime,
    preview: truncatePreview(row.title || ''),
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

/** Plain id list — used by the spawn-time watcher to diff before/after. */
export async function listOpencodeSessionIdsForCwd(cwd: string): Promise<string[]> {
  const rows = await runSessionList();
  if (!rows) return [];
  const target = normalizeCwd(cwd);
  return rows
    .filter(r => r.directory && normalizeCwd(r.directory) === target)
    .map(r => r.id);
}
