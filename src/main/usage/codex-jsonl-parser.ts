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
  priorReasoningEffort?: string | null;
  priorContextWindowTokens?: number | null;
  priorContextUsedTokens?: number | null;
  priorTokenUsage?: CodexTokenUsageCounters | null;
}

export interface CodexParseResult {
  messages: ParsedMessage[];
  newByteOffset: number;
  /** Model in effect at end of the parsed chunk; persist for the next call. */
  currentModel: string | null;
  currentReasoningEffort: string | null;
  contextWindowTokens: number | null;
  contextUsedTokens: number | null;
  observedAt: string | null;
  tokenUsage: CodexTokenUsageCounters | null;
}

export interface CodexTokenUsageCounters {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

interface TurnContextEntry {
  type?: string;
  payload?: {
    model?: unknown;
    effort?: unknown;
    model_context_window?: unknown;
    collaboration_mode?: {
      settings?: {
        reasoning_effort?: unknown;
      };
    };
  };
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
        total_tokens?: number;
      } | null;
      total_token_usage?: {
        input_tokens?: number;
        cached_input_tokens?: number;
        output_tokens?: number;
        reasoning_output_tokens?: number;
        total_tokens?: number;
      } | null;
      model_context_window?: number;
    } | null;
  };
}

interface TaskStartedEntry {
  type?: string;
  payload?: {
    model_context_window?: unknown;
  };
}

/**
 * Incrementally parse a Codex CLI JSONL transcript starting from a byte
 * offset. Codex emits per-turn token deltas as `event_msg` lines whose
 * `payload.type` is `token_count`; the accompanying `last_token_usage`
 * carries token counts. Newer Codex emits cumulative `total_token_usage`,
 * which we diff against the last persisted counters so repeated snapshots do
 * not double-count after incremental parses or app restarts. Older transcripts
 * fall back to `last_token_usage` as a per-event delta. The active
 * model is published in `turn_context` lines and applies to every
 * subsequent `token_count` until the next `turn_context`.
 *
 * Cache semantics differ from Claude: Codex exposes cached input reads
 * (`cached_input_tokens`) but not cache creation, so the 5m/1h fields are
 * always 0. `input_tokens` already includes the cached portion, so we
 * subtract `cached_input_tokens` to keep `inputTokens` non-cached for cost
 * calculation. `reasoning_output_tokens` is a subset of `output_tokens`, so it
 * is retained as a separate metric but never added to billable output.
 */
export function parseCodexJsonl(filePath: string, input: CodexParseInput): CodexParseResult {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const fileSize = stat.size;

    if (fileSize <= input.startOffset) {
      return {
        messages: [],
        newByteOffset: input.startOffset,
        currentModel: input.priorModel,
        currentReasoningEffort: input.priorReasoningEffort ?? null,
        contextWindowTokens: input.priorContextWindowTokens ?? null,
        contextUsedTokens: input.priorContextUsedTokens ?? null,
        observedAt: null,
        tokenUsage: input.priorTokenUsage ?? null,
      };
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
        return {
          messages: [],
          newByteOffset: input.startOffset,
          currentModel: input.priorModel,
          currentReasoningEffort: input.priorReasoningEffort ?? null,
          contextWindowTokens: input.priorContextWindowTokens ?? null,
          contextUsedTokens: input.priorContextUsedTokens ?? null,
          observedAt: null,
          tokenUsage: input.priorTokenUsage ?? null,
        };
      }
      usableText = text.slice(0, lastNewline + 1);
      consumedBytes = Buffer.byteLength(usableText, 'utf-8');
    }

    const messages: ParsedMessage[] = [];
    let currentModel = input.priorModel;
    let currentReasoningEffort = input.priorReasoningEffort ?? null;
    let contextWindowTokens = input.priorContextWindowTokens ?? null;
    let contextUsedTokens = input.priorContextUsedTokens ?? null;
    let observedAt: string | null = null;
    let tokenUsage = input.priorTokenUsage ?? null;

    for (const line of usableText.split('\n')) {
      if (!line.startsWith('{')) continue;

      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { continue; }
      if (!parsed || typeof parsed !== 'object') continue;

      const type = (parsed as { type?: string }).type;

      if (type === 'turn_context') {
        const payload = (parsed as TurnContextEntry).payload;
        const model = payload?.model;
        if (typeof model === 'string' && model) currentModel = model;
        const effort = payload?.effort ?? payload?.collaboration_mode?.settings?.reasoning_effort;
        if (typeof effort === 'string' && effort) currentReasoningEffort = effort;
        const windowTokens = payload?.model_context_window;
        if (typeof windowTokens === 'number' && Number.isFinite(windowTokens)) {
          contextWindowTokens = windowTokens;
        }
        continue;
      }

      if (type === 'event_msg' && (parsed as { payload?: { type?: string } }).payload?.type === 'task_started') {
        const windowTokens = (parsed as TaskStartedEntry).payload?.model_context_window;
        if (typeof windowTokens === 'number' && Number.isFinite(windowTokens)) {
          contextWindowTokens = windowTokens;
        }
        continue;
      }

      if (type !== 'event_msg') continue;

      const entry = parsed as TokenCountEntry;
      if (entry.payload?.type !== 'token_count') continue;
      const usage = entry.payload.info?.last_token_usage;
      if (!usage) continue;

      const cumulativeUsage = toTokenUsage(entry.payload.info?.total_token_usage);
      const lastUsage = toTokenUsage(usage);
      const usageDelta = cumulativeUsage
        ? diffCumulativeUsage(cumulativeUsage, tokenUsage)
        : lastUsage;
      if (!usageDelta) continue;

      if (cumulativeUsage) {
        tokenUsage = cumulativeUsage;
      }

      const rawInput = usageDelta.inputTokens;
      const cacheRead = usageDelta.cachedInputTokens;
      const inputTokens = Math.max(0, rawInput - cacheRead);
      const outputTokens = usageDelta.outputTokens;
      const reasoningTokens = usageDelta.reasoningOutputTokens;
      const requestTotal = lastUsage?.totalTokens ?? 0;
      contextUsedTokens = requestTotal > 0 ? requestTotal : (rawInput + outputTokens);
      observedAt = entry.timestamp || new Date().toISOString();
      const windowTokens = entry.payload.info?.model_context_window;
      if (typeof windowTokens === 'number' && Number.isFinite(windowTokens)) {
        contextWindowTokens = windowTokens;
      }

      // Skip empty deltas — the first token_count after session_meta sometimes
      // has zeros while the rate-limit info is the only payload of interest.
      if (inputTokens === 0 && cacheRead === 0 && outputTokens === 0 && reasoningTokens === 0) continue;

      const model = currentModel || 'unknown';
      const cost = calculateMessageCost(model, inputTokens, outputTokens, 0, 0, cacheRead);

      messages.push({
        model,
        inputTokens,
        outputTokens,
        reasoningTokens,
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
      currentReasoningEffort,
      contextWindowTokens,
      contextUsedTokens,
      observedAt,
      tokenUsage,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        messages: [],
        newByteOffset: 0,
        currentModel: input.priorModel,
        currentReasoningEffort: input.priorReasoningEffort ?? null,
        contextWindowTokens: input.priorContextWindowTokens ?? null,
        contextUsedTokens: input.priorContextUsedTokens ?? null,
        observedAt: null,
        tokenUsage: input.priorTokenUsage ?? null,
      };
    }
    throw err;
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function toTokenUsage(value: unknown): CodexTokenUsageCounters | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const inputTokens = nonNegativeNumber(record.input_tokens);
  const cachedInputTokens = nonNegativeNumber(record.cached_input_tokens);
  const outputTokens = nonNegativeNumber(record.output_tokens);
  const reasoningOutputTokens = nonNegativeNumber(record.reasoning_output_tokens);
  const explicitTotal = nonNegativeNumber(record.total_tokens);
  if (inputTokens === 0 && cachedInputTokens === 0 && outputTokens === 0 && reasoningOutputTokens === 0 && explicitTotal === 0) {
    return null;
  }
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens: explicitTotal || inputTokens + outputTokens,
  };
}

function diffCumulativeUsage(current: CodexTokenUsageCounters, previous: CodexTokenUsageCounters | null): CodexTokenUsageCounters {
  if (!previous || current.totalTokens < previous.totalTokens) {
    return current;
  }
  if (current.totalTokens === previous.totalTokens) {
    return {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: current.totalTokens,
    };
  }
  return {
    inputTokens: Math.max(0, current.inputTokens - previous.inputTokens),
    cachedInputTokens: Math.max(0, current.cachedInputTokens - previous.cachedInputTokens),
    outputTokens: Math.max(0, current.outputTokens - previous.outputTokens),
    reasoningOutputTokens: Math.max(0, current.reasoningOutputTokens - previous.reasoningOutputTokens),
    totalTokens: current.totalTokens,
  };
}
