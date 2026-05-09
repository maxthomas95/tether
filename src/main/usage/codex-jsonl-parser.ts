import * as fs from 'node:fs';
import { calculateMessageCost } from './model-pricing';
import type { ParsedMessage } from './jsonl-parser';

export interface CodexParseInput {
  startOffset: number;
  /**
   * Most recent model id seen in a prior parse of this file. Used when the
   * appended chunk emits a `token_count` event before the next `turn_context`
   * (rare but possible mid-turn). Pass null on the first parse.
   */
  priorModel: string | null;
}

export interface CodexParseResult {
  messages: ParsedMessage[];
  newByteOffset: number;
  /** Model in effect at end of the parsed chunk; persist for the next call. */
  currentModel: string | null;
}

interface TurnContextEntry {
  type?: string;
  payload?: { model?: unknown };
}

interface TokenCountEntry {
  type?: string;
  timestamp?: string;
  payload?: {
    type?: string;
    info?: {
      last_token_usage?: {
        input_tokens?: number;
        cached_input_tokens?: number;
        output_tokens?: number;
        reasoning_output_tokens?: number;
      } | null;
    } | null;
  };
}

/**
 * Incrementally parse a Codex CLI JSONL transcript starting from a byte
 * offset. Codex emits per-turn token deltas as `event_msg` lines whose
 * `payload.type` is `token_count`; the accompanying `last_token_usage`
 * carries non-cumulative input/cached/output/reasoning counts. The active
 * model is published in `turn_context` lines and applies to every
 * subsequent `token_count` until the next `turn_context`.
 *
 * Cache semantics differ from Claude: Codex exposes cached input reads
 * (`cached_input_tokens`) but not cache creation, so the 5m/1h fields are
 * always 0. `input_tokens` already includes the cached portion, so we
 * subtract `cached_input_tokens` to keep `inputTokens` non-cached for cost
 * calculation. Reasoning tokens are billed at output rates and folded
 * into `outputTokens`.
 */
export function parseCodexJsonl(filePath: string, input: CodexParseInput): CodexParseResult {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const fileSize = stat.size;

    if (fileSize <= input.startOffset) {
      return { messages: [], newByteOffset: input.startOffset, currentModel: input.priorModel };
    }

    const readLength = fileSize - input.startOffset;
    const buf = Buffer.alloc(readLength);
    const bytesRead = fs.readSync(fd, buf, 0, readLength, input.startOffset);
    const text = buf.slice(0, bytesRead).toString('utf-8');

    let usableText = text;
    let consumedBytes = bytesRead;

    if (text.length > 0 && !text.endsWith('\n')) {
      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline === -1) {
        return { messages: [], newByteOffset: input.startOffset, currentModel: input.priorModel };
      }
      usableText = text.slice(0, lastNewline + 1);
      consumedBytes = Buffer.byteLength(usableText, 'utf-8');
    }

    const messages: ParsedMessage[] = [];
    let currentModel = input.priorModel;

    for (const line of usableText.split('\n')) {
      if (!line.startsWith('{')) continue;

      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { continue; }
      if (!parsed || typeof parsed !== 'object') continue;

      const type = (parsed as { type?: string }).type;

      if (type === 'turn_context') {
        const model = (parsed as TurnContextEntry).payload?.model;
        if (typeof model === 'string' && model) currentModel = model;
        continue;
      }

      if (type !== 'event_msg') continue;

      const entry = parsed as TokenCountEntry;
      if (entry.payload?.type !== 'token_count') continue;
      const usage = entry.payload.info?.last_token_usage;
      if (!usage) continue;

      const rawInput = usage.input_tokens || 0;
      const cacheRead = usage.cached_input_tokens || 0;
      const inputTokens = Math.max(0, rawInput - cacheRead);
      const outputTokens = (usage.output_tokens || 0) + (usage.reasoning_output_tokens || 0);

      // Skip empty deltas — the first token_count after session_meta sometimes
      // has zeros while the rate-limit info is the only payload of interest.
      if (inputTokens === 0 && cacheRead === 0 && outputTokens === 0) continue;

      const model = currentModel || 'unknown';
      const cost = calculateMessageCost(model, inputTokens, outputTokens, 0, 0, cacheRead);

      messages.push({
        model,
        inputTokens,
        outputTokens,
        cacheCreation5m: 0,
        cacheCreation1h: 0,
        cacheReadTokens: cacheRead,
        timestamp: entry.timestamp || new Date().toISOString(),
        cost,
      });
    }

    return {
      messages,
      newByteOffset: input.startOffset + consumedBytes,
      currentModel,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { messages: [], newByteOffset: 0, currentModel: input.priorModel };
    }
    throw err;
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}
