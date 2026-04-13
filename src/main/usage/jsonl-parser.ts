import * as fs from 'node:fs';
import { calculateMessageCost } from './model-pricing';

export interface ParsedMessage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreation5m: number;
  cacheCreation1h: number;
  cacheReadTokens: number;
  timestamp: string;
  cost: number;
}

export interface ParseResult {
  messages: ParsedMessage[];
  newByteOffset: number;
}

interface JsonlUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

interface JsonlEntry {
  type?: string;
  message?: {
    model?: string;
    usage?: JsonlUsage;
  };
  timestamp?: string;
}

/**
 * Incrementally parse a Claude Code JSONL transcript file starting from
 * a byte offset. Only extracts token usage from assistant messages.
 * Returns parsed messages and the new byte offset for the next call.
 */
export function parseJsonlFile(filePath: string, startOffset: number): ParseResult {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const fileSize = stat.size;

    if (fileSize <= startOffset) {
      return { messages: [], newByteOffset: startOffset };
    }

    const readLength = fileSize - startOffset;
    const buf = Buffer.alloc(readLength);
    const bytesRead = fs.readSync(fd, buf, 0, readLength, startOffset);
    const text = buf.slice(0, bytesRead).toString('utf-8');

    // Handle partial last line — if text doesn't end with \n, the last
    // line is incomplete (file still being written). Discard it and set
    // offset to retry on the next parse.
    let usableText = text;
    let consumedBytes = bytesRead;

    if (text.length > 0 && !text.endsWith('\n')) {
      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline === -1) {
        // Entire chunk is a partial line — nothing to parse yet
        return { messages: [], newByteOffset: startOffset };
      }
      usableText = text.slice(0, lastNewline + 1);
      consumedBytes = Buffer.byteLength(usableText, 'utf-8');
    }

    const messages: ParsedMessage[] = [];

    for (const line of usableText.split('\n')) {
      if (!line.startsWith('{')) continue;

      let entry: JsonlEntry;
      try { entry = JSON.parse(line); } catch { continue; }

      if (entry.type !== 'assistant') continue;
      const usage = entry.message?.usage;
      if (!usage) continue;

      const model = entry.message?.model || 'unknown';
      const inputTokens = usage.input_tokens || 0;
      const outputTokens = usage.output_tokens || 0;
      const cacheReadTokens = usage.cache_read_input_tokens || 0;

      // Cache creation breakdown: prefer granular 5m/1h split.
      // If breakdown missing, treat all cache_creation as 1h (ccusage convention).
      let cacheCreate5m = 0;
      let cacheCreate1h = 0;
      if (usage.cache_creation) {
        cacheCreate5m = usage.cache_creation.ephemeral_5m_input_tokens || 0;
        cacheCreate1h = usage.cache_creation.ephemeral_1h_input_tokens || 0;
      } else if (usage.cache_creation_input_tokens) {
        cacheCreate1h = usage.cache_creation_input_tokens;
      }

      const cost = calculateMessageCost(
        model, inputTokens, outputTokens,
        cacheCreate5m, cacheCreate1h, cacheReadTokens,
      );

      messages.push({
        model,
        inputTokens,
        outputTokens,
        cacheCreation5m: cacheCreate5m,
        cacheCreation1h: cacheCreate1h,
        cacheReadTokens,
        timestamp: entry.timestamp || new Date().toISOString(),
        cost,
      });
    }

    return {
      messages,
      newByteOffset: startOffset + consumedBytes,
    };
  } catch (err) {
    // File doesn't exist or is unreadable — return empty
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { messages: [], newByteOffset: 0 };
    }
    throw err;
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}
