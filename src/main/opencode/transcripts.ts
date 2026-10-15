import path from 'node:path';
import type { TranscriptInfo } from '../../shared/types';
import { createLogger } from '../logger';
import { runCliMetadata } from '../cli/metadata-command';

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

function isSessionRow(value: unknown): value is OpencodeSessionRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === 'string' && row.id.length > 0
    && typeof row.directory === 'string' && row.directory.length > 0
    && !row.directory.includes('\0');
}

/**
 * Run `opencode session list --format json` and parse the array. We shell out
 * because opencode 1.x migrated session storage to SQLite (`opencode.db`) and
 * the CLI is the only stable interface — reading the DB directly would couple
 * us to its private schema. The CLI is fast (single-shot, no daemon required).
 *
 * Optional CLI failures degrade to "no transcripts" without exposing output.
 */
async function runSessionList(): Promise<OpencodeSessionRow[]> {
  const result = await runCliMetadata('opencode', ['session', 'list', '--format', 'json']);
  if (!result.ok) return [];
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? parsed.filter(isSessionRow) : [];
  } catch {
    // Parse errors can include transcript excerpts; never log the payload.
    log.warn('opencode session list returned unparseable JSON');
    return [];
  }
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
  const target = normalizeCwd(cwd);
  return rows.some(r => r.id === sessionId && r.directory && normalizeCwd(r.directory) === target);
}
