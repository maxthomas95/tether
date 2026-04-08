import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import type { TranscriptInfo } from '../../shared/types';

/**
 * Claude Code stores per-conversation JSONL transcripts at
 *   ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
 *
 * The encoded-cwd is the working directory with `\`, `/`, and `:` replaced
 * with `-`. The filename stem is the Claude session UUID.
 */

export function encodeCwdForClaude(cwd: string): string {
  // Match the encoding Claude itself uses (verified against the on-disk layout)
  return cwd.replace(/[\\/:]/g, '-');
}

export function getClaudeProjectsRoot(): string {
  return path.join(app.getPath('home'), '.claude', 'projects');
}

export function getProjectDir(cwd: string): string {
  return path.join(getClaudeProjectsRoot(), encodeCwdForClaude(cwd));
}

export function transcriptPath(cwd: string, sessionId: string): string {
  return path.join(getProjectDir(cwd), `${sessionId}.jsonl`);
}

export function transcriptExists(cwd: string, sessionId: string): boolean {
  try {
    return fs.statSync(transcriptPath(cwd, sessionId)).isFile();
  } catch {
    return false;
  }
}

/**
 * Read up to ~32KB from the start of a JSONL and return the first user-typed
 * prompt as a short preview. Returns empty string if none is found.
 *
 * The first user message in a Claude transcript looks like:
 *   {"type":"user","message":{"role":"user","content":"the prompt text"},...}
 * Subsequent "user" entries are tool results with `content: [...]` arrays —
 * we skip those and only return the first plain-string content.
 */
function extractFirstUserPrompt(filePath: string): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(32 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.slice(0, n).toString('utf-8');
    for (const line of text.split('\n')) {
      if (!line.startsWith('{')) continue;
      let entry: { type?: string; message?: { role?: string; content?: unknown } };
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.type !== 'user') continue;
      const content = entry.message?.content;
      if (typeof content !== 'string') continue;
      const trimmed = content.trim();
      if (!trimmed) continue;
      return trimmed.length > 200 ? trimmed.slice(0, 200) + '…' : trimmed;
    }
    return '';
  } catch {
    return '';
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * List all transcripts for a working directory, newest first. Returns at most
 * `limit` results.
 */
export function listTranscripts(cwd: string, limit = 50): TranscriptInfo[] {
  const dir = getProjectDir(cwd);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const rows: TranscriptInfo[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const id = entry.name.slice(0, -'.jsonl'.length);
    // Filename stems should be UUIDs; defensively skip anything that isn't.
    if (!/^[0-9a-f-]{36}$/i.test(id)) continue;
    const full = path.join(dir, entry.name);
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(full).mtimeMs; } catch { continue; }
    rows.push({
      id,
      mtime: new Date(mtimeMs).toISOString(),
      preview: extractFirstUserPrompt(full),
    });
  }
  rows.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return rows.slice(0, limit);
}
