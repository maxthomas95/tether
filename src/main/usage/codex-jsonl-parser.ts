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
  nativeSessionId?: string | null;
  priorRequestUsage?: CodexRequestUsageCheckpoint | null;
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
  requestUsage: CodexRequestUsageCheckpoint | null;
}

/** Request totals survive compaction; token_count totals describe the CLI context. */
export interface CodexRequestUsageCheckpoint {
  nativeSessionId: string;
  tokenUsage: CodexTokenUsageCounters;
}

export interface CodexTokenUsageCounters {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  cacheWriteInputTokens?: number;
}

interface RequestUsageEntry {
  timestamp?: unknown;
  payload?: {
    thread_id?: unknown;
    usage?: unknown;
    thread_token_usage?: unknown;
  };
}

interface TurnContextEntry {
  type?: string;
  timestamp?: string;
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
  timestamp?: string;
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
 * not double-count after incremental parses or app restarts. Newer transcripts
 * also contain token_usage_record entries: those per-request counts include
 * compaction requests absent from token_count and take over cost accounting.
 * Their independent thread totals deduplicate request replays across restarts.
 * Older transcripts fall back to token_count. The active
 * model is published in `turn_context` lines and applies to every
 * subsequent `token_count` until the next `turn_context`.
 *
 * Cache semantics differ from Claude: Codex exposes cached input reads
 * (`cached_input_tokens`) and, in request records, cache writes. Input tokens
 * already include both cached portions, so we subtract cache reads and writes
 * to keep `inputTokens` non-cached for cost
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
        requestUsage: input.priorRequestUsage ?? null,
      };
    }

    const readLength = fileSize - input.startOffset;
    const buf = Buffer.alloc(readLength);
    const bytesRead = fs.readSync(fd, buf, 0, readLength, input.startOffset);
    const text = buf.slice(0, bytesRead).toString('utf-8');

    return parseCodexUsageText(text, input);
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
        requestUsage: input.priorRequestUsage ?? null,
      };
    }
    throw err;
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/** Parse sanitized remote records and local transcript chunks through the same accounting rules. */
export function parseCodexUsageText(text: string, input: CodexParseInput): CodexParseResult {
  let usableText = text;
  let consumedBytes = Buffer.byteLength(text, 'utf8');

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
        requestUsage: input.priorRequestUsage ?? null,
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
  let requestUsage = input.priorRequestUsage ?? null;
  let nativeSessionId = input.nativeSessionId ?? requestUsage?.nativeSessionId ?? null;

  for (const line of usableText.split('\n')) {
    if (!line.startsWith('{')) continue;

    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!parsed || typeof parsed !== 'object') continue;

    const type = (parsed as { type?: string }).type;

    if (type === 'session_meta') {
      const id = (parsed as { payload?: { id?: unknown } }).payload?.id;
      // Forked transcripts can contain the parent's header after their own.
      if (!nativeSessionId && typeof id === 'string' && id) nativeSessionId = id;
      continue;
    }

    if (type === 'turn_context') {
      const payload = (parsed as TurnContextEntry).payload;
      const timestamp = validTimestamp((parsed as TurnContextEntry).timestamp);
      const model = payload?.model;
      if (typeof model === 'string' && model) currentModel = model;
      const effort = payload?.effort ?? payload?.collaboration_mode?.settings?.reasoning_effort;
      if (typeof effort === 'string' && effort) currentReasoningEffort = effort;
      const windowTokens = payload?.model_context_window;
      if (isNonNegativeSafeInteger(windowTokens)) {
        contextWindowTokens = windowTokens;
      }
      if (timestamp) observedAt = timestamp;
      continue;
    }

    if (type === 'token_usage_record') {
      const entry = parsed as RequestUsageEntry;
      const timestamp = validTimestamp(entry.timestamp);
      const threadId = entry.payload?.thread_id;
      const usage = toTokenUsage(entry.payload?.usage);
      const cumulative = toTokenUsage(entry.payload?.thread_token_usage);
      if (!timestamp || typeof threadId !== 'string' || !threadId || !usage || !cumulative) continue;
      if (nativeSessionId && threadId !== nativeSessionId) continue;
      if (!countersCover(cumulative, usage)) continue;
      nativeSessionId = threadId;

      // A separate monotonic checkpoint is essential: compaction resets the
      // context counters but does not reset the request ledger. Older/repeated
      // snapshots never become new spend, including after an app restart.
      if (requestUsage && cumulative.totalTokens <= requestUsage.tokenUsage.totalTokens) continue;
      const alreadyCounted = !requestUsage && tokenUsage && countersCover(tokenUsage, cumulative);
      requestUsage = { nativeSessionId: threadId, tokenUsage: cumulative };
      observedAt = timestamp;
      if (!alreadyCounted) messages.push(usageMessage(usage, currentModel, timestamp));
      continue;
    }

    if (type === 'event_msg' && (parsed as { payload?: { type?: string } }).payload?.type === 'task_started') {
      const timestamp = validTimestamp((parsed as TaskStartedEntry).timestamp);
      const windowTokens = (parsed as TaskStartedEntry).payload?.model_context_window;
      if (isNonNegativeSafeInteger(windowTokens)) {
        contextWindowTokens = windowTokens;
      }
      if (timestamp) observedAt = timestamp;
      continue;
    }

    if (type !== 'event_msg') continue;

    const entry = parsed as TokenCountEntry;
    if (entry.payload?.type !== 'token_count') continue;
    const timestamp = validTimestamp(entry.timestamp);
    if (!timestamp) continue;

    const cumulativeUsage = toTokenUsage(entry.payload.info?.total_token_usage);
    const lastUsage = toTokenUsage(entry.payload.info?.last_token_usage);
    const usageDelta = cumulativeUsage
      ? diffCumulativeUsage(cumulativeUsage, tokenUsage)
      : lastUsage;
    if (!usageDelta) continue;

    if (cumulativeUsage) {
      tokenUsage = cumulativeUsage;
    }

    const requestTotal = lastUsage?.totalTokens ?? 0;
    if (requestTotal > 0) contextUsedTokens = requestTotal;
    observedAt = timestamp;
    const windowTokens = entry.payload.info?.model_context_window;
    if (isNonNegativeSafeInteger(windowTokens)) {
      contextWindowTokens = windowTokens;
    }

    // Skip empty deltas — the first token_count after session_meta sometimes
    // has zeros while the rate-limit info is the only payload of interest.
    // Retain context metadata from token_count even when requests own billing.
    if (!requestUsage && usageDelta.totalTokens > 0) {
      messages.push(usageMessage(usageDelta, currentModel, timestamp));
    }
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
    requestUsage,
  };
}

function usageMessage(usage: CodexTokenUsageCounters, currentModel: string | null, timestamp: string): ParsedMessage {
  const model = currentModel || 'unknown';
  const cacheReadTokens = usage.cachedInputTokens;
  const cacheCreation5m = usage.cacheWriteInputTokens ?? 0;
  const inputTokens = Math.max(0, usage.inputTokens - cacheReadTokens - cacheCreation5m);
  return {
    model, inputTokens, outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningOutputTokens,
    cacheCreation5m, cacheCreation1h: 0, cacheReadTokens, timestamp,
    cost: calculateMessageCost(model, inputTokens, usage.outputTokens, cacheCreation5m, 0, cacheReadTokens),
  };
}

function countersCover(total: CodexTokenUsageCounters, part: CodexTokenUsageCounters): boolean {
  return total.totalTokens >= part.totalTokens
    && total.inputTokens >= part.inputTokens
    && total.cachedInputTokens >= part.cachedInputTokens
    && total.outputTokens >= part.outputTokens
    && total.reasoningOutputTokens >= part.reasoningOutputTokens
    && (total.cacheWriteInputTokens ?? 0) >= (part.cacheWriteInputTokens ?? 0);
}

function validTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : value;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0;
}

function optionalCounter(value: unknown): number | null {
  return isNonNegativeSafeInteger(value) ? value : null;
}

function toTokenUsage(value: unknown): CodexTokenUsageCounters | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const inputTokens = optionalCounter(record.input_tokens) ?? 0;
  const cachedInputTokens = optionalCounter(record.cached_input_tokens) ?? 0;
  const cacheWriteInputTokens = optionalCounter(record.cache_write_input_tokens) ?? 0;
  const outputTokens = optionalCounter(record.output_tokens) ?? 0;
  const reasoningOutputTokens = optionalCounter(record.reasoning_output_tokens) ?? 0;
  const explicitTotal = optionalCounter(record.total_tokens);
  if (inputTokens === 0 && cachedInputTokens === 0 && outputTokens === 0 && reasoningOutputTokens === 0 && (explicitTotal ?? 0) === 0) {
    return null;
  }
  if (
    optionalCounter(record.input_tokens) === null && record.input_tokens !== undefined
    || optionalCounter(record.cached_input_tokens) === null && record.cached_input_tokens !== undefined
    || optionalCounter(record.cache_write_input_tokens) === null && record.cache_write_input_tokens !== undefined
    || optionalCounter(record.output_tokens) === null && record.output_tokens !== undefined
    || optionalCounter(record.reasoning_output_tokens) === null && record.reasoning_output_tokens !== undefined
    || explicitTotal === null && record.total_tokens !== undefined
    || cachedInputTokens + cacheWriteInputTokens > inputTokens
    || reasoningOutputTokens > outputTokens
    || (explicitTotal !== null && explicitTotal !== inputTokens + outputTokens)
  ) {
    return null;
  }
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens: explicitTotal ?? inputTokens + outputTokens,
    ...(cacheWriteInputTokens > 0 ? { cacheWriteInputTokens } : {}),
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
      totalTokens: 0,
    };
  }
  return {
    inputTokens: Math.max(0, current.inputTokens - previous.inputTokens),
    cachedInputTokens: Math.max(0, current.cachedInputTokens - previous.cachedInputTokens),
    outputTokens: Math.max(0, current.outputTokens - previous.outputTokens),
    reasoningOutputTokens: Math.max(0, current.reasoningOutputTokens - previous.reasoningOutputTokens),
    totalTokens: current.totalTokens - previous.totalTokens,
    ...((current.cacheWriteInputTokens ?? 0) > (previous.cacheWriteInputTokens ?? 0)
      ? { cacheWriteInputTokens: (current.cacheWriteInputTokens ?? 0) - (previous.cacheWriteInputTokens ?? 0) }
      : {}),
  };
}
