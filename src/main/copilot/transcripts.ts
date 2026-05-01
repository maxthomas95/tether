import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import type { TranscriptInfo } from '../../shared/types';

/**
 * GitHub Copilot CLI stores per-session state at
 *   ~/.copilot/session-state/<uuid>/
 *     events.jsonl    — streaming event log
 *     workspace.yaml  — session metadata (cwd, repository, branch, summary, …)
 *     checkpoints/    — compaction history
 *
 * The dirname IS the session id. Resume by id: `copilot --resume <uuid>`.
 * (Copilot also accepts 7+ char hex prefixes, but we always pass the full id.)
 *
 * We deliberately don't pull in a YAML dependency — workspace.yaml is shallow
 * scalar key/value at the top level, so a defensive line-based parser is fine.
 * If Copilot ever migrates to a different metadata format we'll see empty
 * results and can adapt.
 */

export function getCopilotHome(): string {
  return process.env.COPILOT_CONFIG_DIR || path.join(app.getPath('home'), '.copilot');
}

export function getCopilotSessionStateRoot(copilotHome = getCopilotHome()): string {
  return path.join(copilotHome, 'session-state');
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
 * Parse a top-level scalar string from a YAML document. Looks for the first
 * line whose unindented form is `key: value`. Strips matching quotes around
 * the value. Returns null if the key isn't present or has a non-scalar shape.
 */
function readYamlString(doc: string, key: string): string | null {
  const re = new RegExp(`^${key}\\s*:\\s*(.*)$`, 'm');
  const m = re.exec(doc);
  if (!m) return null;
  let value = m[1].trim();
  if (!value || value === '|' || value === '>') return null;
  // Strip a trailing inline comment that's preceded by whitespace.
  const hashIdx = value.search(/\s#/);
  if (hashIdx >= 0) value = value.slice(0, hashIdx).trim();
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value || null;
}

interface CopilotWorkspaceMeta {
  cwd: string;
  summary?: string;
  repository?: string;
  branch?: string;
}

function readWorkspaceMeta(filePath: string): CopilotWorkspaceMeta | null {
  let text: string;
  try {
    // workspace.yaml is small (kilobytes); reading it fully is cheaper than
    // working a streaming parser around YAML quoting rules.
    text = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
  const cwd = readYamlString(text, 'cwd');
  if (!cwd) return null;
  return {
    cwd,
    summary: readYamlString(text, 'summary') || undefined,
    repository: readYamlString(text, 'repository') || undefined,
    branch: readYamlString(text, 'branch') || undefined,
  };
}

/**
 * Read up to ~64KB from the start of events.jsonl and return the first
 * `user.message` event's content as a preview. The Copilot event log uses
 * the same shape as its in-process event API:
 *   {"type":"user.message","data":{"content":"…","attachments":[],"source":"…"},"timestamp":"…"}
 * Some entries may flatten `content` to the top level — handle both.
 */
function extractFirstUserPrompt(filePath: string): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.slice(0, n).toString('utf-8');
    for (const line of text.split('\n')) {
      const l = line.trim();
      if (!l.startsWith('{')) continue;
      let entry: { type?: string; data?: { content?: unknown }; content?: unknown };
      try { entry = JSON.parse(l); } catch { continue; }
      if (entry.type !== 'user.message') continue;
      const content = entry.data?.content ?? entry.content;
      if (typeof content !== 'string') continue;
      const trimmed = content.trim();
      if (!trimmed) continue;
      return truncatePreview(trimmed);
    }
    return '';
  } catch {
    return '';
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * Enumerate all session directories. Returns absolute paths and dirnames.
 */
export function listCopilotSessionDirs(copilotHome = getCopilotHome()): Array<{ id: string; dir: string }> {
  const root = getCopilotSessionStateRoot(copilotHome);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(e => e.isDirectory())
    .map(e => ({ id: e.name, dir: path.join(root, e.name) }));
}

/**
 * List Copilot transcripts whose `workspace.yaml` cwd matches the given cwd,
 * newest first. Returns at most `limit` results.
 */
export function listCopilotTranscripts(cwd: string, limit = 50, copilotHome = getCopilotHome()): TranscriptInfo[] {
  const target = normalizeCwd(cwd);
  const rows: TranscriptInfo[] = [];

  for (const { id, dir } of listCopilotSessionDirs(copilotHome)) {
    const workspaceFile = path.join(dir, 'workspace.yaml');
    const meta = readWorkspaceMeta(workspaceFile);
    if (!meta || normalizeCwd(meta.cwd) !== target) continue;

    const eventsFile = path.join(dir, 'events.jsonl');
    let mtimeMs = 0;
    try {
      // events.jsonl mtime is the most recent activity; falls back to the
      // session dir mtime if the events file isn't there yet.
      mtimeMs = fs.statSync(eventsFile).mtimeMs;
    } catch {
      try { mtimeMs = fs.statSync(dir).mtimeMs; } catch { continue; }
    }

    rows.push({
      id,
      mtime: new Date(mtimeMs).toISOString(),
      preview: meta.summary
        ? truncatePreview(meta.summary)
        : extractFirstUserPrompt(eventsFile),
      cliTool: 'copilot',
      sourcePath: dir,
    });
  }

  rows.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return rows.slice(0, limit);
}

export function copilotTranscriptExists(cwd: string, sessionId: string, copilotHome = getCopilotHome()): boolean {
  const dir = path.join(getCopilotSessionStateRoot(copilotHome), sessionId);
  const meta = readWorkspaceMeta(path.join(dir, 'workspace.yaml'));
  if (!meta) return false;
  return normalizeCwd(meta.cwd) === normalizeCwd(cwd);
}
