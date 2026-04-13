import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import type { TranscriptInfo } from '../../shared/types';

interface CodexSessionMeta {
  id: string;
  cwd: string;
  timestamp?: string;
}

interface CodexHistoryEntry {
  session_id?: string;
  text?: string;
}

export function getCodexHome(): string {
  return process.env.CODEX_HOME || path.join(app.getPath('home'), '.codex');
}

export function getCodexSessionsRoot(codexHome = getCodexHome()): string {
  return path.join(codexHome, 'sessions');
}

function normalizeCwd(cwd: string): string {
  const resolved = path.resolve(cwd);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function truncatePreview(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}...` : trimmed;
}

function parseSessionMetaLine(line: string): CodexSessionMeta | null {
  if (!line.includes('"type":"session_meta"')) {
    return null;
  }

  try {
    const entry = JSON.parse(line) as {
      timestamp?: string;
      type?: string;
      payload?: {
        id?: string;
        cwd?: string;
        timestamp?: string;
      };
    };
    if (entry.type !== 'session_meta') {
      return null;
    }
    const id = entry.payload?.id;
    const cwd = entry.payload?.cwd;
    if (typeof id !== 'string' || typeof cwd !== 'string') {
      return null;
    }
    return {
      id,
      cwd,
      timestamp: entry.payload?.timestamp || entry.timestamp,
    };
  } catch {
    return null;
  }
}

function readSessionMeta(filePath: string): CodexSessionMeta | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.slice(0, n).toString('utf-8');
    for (const line of text.split('\n')) {
      const meta = parseSessionMetaLine(line);
      if (meta) {
        return meta;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function walkJsonlFiles(root: string): string[] {
  const result: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...walkJsonlFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      result.push(full);
    }
  }
  return result;
}

function readHistoryPreviews(codexHome: string): Map<string, string> {
  const previews = new Map<string, string>();
  const historyPath = path.join(codexHome, 'history.jsonl');
  let contents: string;
  try {
    contents = fs.readFileSync(historyPath, 'utf-8');
  } catch {
    return previews;
  }

  for (const line of contents.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as CodexHistoryEntry;
      if (typeof entry.session_id !== 'string' || typeof entry.text !== 'string') {
        continue;
      }
      if (!previews.has(entry.session_id)) {
        previews.set(entry.session_id, truncatePreview(entry.text));
      }
    } catch {
      continue;
    }
  }

  return previews;
}

export function listCodexTranscripts(cwd: string, limit = 50, codexHome = getCodexHome()): TranscriptInfo[] {
  const root = getCodexSessionsRoot(codexHome);
  const targetCwd = normalizeCwd(cwd);
  const previews = readHistoryPreviews(codexHome);
  const rows: TranscriptInfo[] = [];

  for (const full of walkJsonlFiles(root)) {
    const meta = readSessionMeta(full);
    if (!meta || normalizeCwd(meta.cwd) !== targetCwd) {
      continue;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }

    rows.push({
      id: meta.id,
      mtime: meta.timestamp || stat.mtime.toISOString(),
      preview: previews.get(meta.id) || '',
      cliTool: 'codex',
      sourcePath: full,
    });
  }

  rows.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return rows.slice(0, limit);
}

export function codexTranscriptExists(cwd: string, sessionId: string, codexHome = getCodexHome()): boolean {
  return listCodexTranscripts(cwd, Number.MAX_SAFE_INTEGER, codexHome).some(row => row.id === sessionId);
}

export function findLatestCodexTranscript(cwd: string, codexHome = getCodexHome()): TranscriptInfo | null {
  return listCodexTranscripts(cwd, 1, codexHome)[0] || null;
}
