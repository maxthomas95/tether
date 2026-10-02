import { open } from 'node:fs/promises';
import { scrubLogText } from '../diagnostics/scrub';

/** Read only a bounded tail of an already-attributed local transcript. Never parse PTY output. */
export async function readRecentPrompt(filePath: string, now = Date.now()): Promise<string | null> {
  const file = await open(filePath, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) return null;
    const start = Math.max(0, stat.size - 64 * 1024);
    const buffer = Buffer.alloc(Math.min(stat.size, 64 * 1024));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    if (start > 0) lines.shift();
    for (const line of lines.reverse()) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const time = Date.parse(row?.timestamp);
      if (!Number.isFinite(time) || now - time > 5 * 60_000 || time > now + 1000) continue;
      const text = row?.type === 'event_msg' && row?.payload?.type === 'user_message'
        ? row.payload.message : row?.type === 'user' && !row.isMeta ? row.message?.content : null;
      if (typeof text !== 'string' || !text.trim()) continue;
      // Scrubbing is best effort, not a promise that arbitrary secrets can be detected.
      return scrubLogText(text).replace(/\b(sk-[A-Za-z0-9_-]{16,}|(?:password|token|api[_-]?key)\s*[:=]\s*\S+)/gi, '[REDACTED]')
        .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').slice(0, 400);
    }
    return null;
  } finally {
    await file.close();
  }
}
