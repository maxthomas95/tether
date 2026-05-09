import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../logger';
import litellmPricesBundled from './litellm-prices.json';

const log = createLogger('pricing');

export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Optional explicit cache rates from LiteLLM; falls back to input × multipliers when absent. */
  cacheCreate5mPerMTok?: number;
  cacheCreate1hPerMTok?: number;
  cacheReadPerMTok?: number;
}

/**
 * Pricing is sourced from a vendored copy of LiteLLM's
 * `model_prices_and_context_window.json` (see ./litellm-prices.json).
 * The bundled file ships with each release as a fallback.
 *
 * At app start, `loadPrices()` looks for a fresher copy in
 * `{userData}/litellm-prices.json` written by `pricing-fetcher.ts`. When
 * the fetcher succeeds it calls `reloadPrices()` to invalidate the
 * in-memory cache; live UI does not refresh, but the next launch (and
 * any new sessions opened after) picks up the new data.
 *
 * Cache costs (when LiteLLM omits them) are derived from input rates:
 *   cache_create (5m TTL) = input × 1.25
 *   cache_create (1h TTL) = input × 2.0
 *   cache_read            = input × 0.1
 *
 * This file only applies to Claude JSONL transcripts (see
 * `calculateMessageCost` callers). Crush/OpenCode sessions use Crush's
 * pre-computed cost from `crush.db` directly and never hit this code path.
 */

interface LiteLLMEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_creation_input_token_cost?: number;
  cache_creation_input_token_cost_above_1hr?: number;
  cache_read_input_token_cost?: number;
  litellm_provider?: string;
  mode?: string;
}

// Active lookup table. Initialized to the bundled JSON; `loadPrices()`
// can swap it for the userData cache when present.
let litellmTable: Record<string, unknown> = litellmPricesBundled as Record<string, unknown>;

// Prefix-based fallback for Anthropic models not in LiteLLM's table yet.
const PREFIX_PRICING: Array<[string, ModelPricing]> = [
  ['claude-opus',   { inputPerMTok: 5,  outputPerMTok: 25 }],
  ['claude-sonnet', { inputPerMTok: 3,  outputPerMTok: 15 }],
  ['claude-haiku',  { inputPerMTok: 1,  outputPerMTok: 5  }],
];

const DEFAULT_PRICING: ModelPricing = { inputPerMTok: 3, outputPerMTok: 15 };

const warnedModels = new Set<string>();
const pricingCache = new Map<string, ModelPricing>();

function isLiteLLMEntry(value: unknown): value is LiteLLMEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.input_cost_per_token === 'number' &&
    typeof v.output_cost_per_token === 'number'
  );
}

function fromLiteLLM(entry: LiteLLMEntry): ModelPricing {
  const inputPerMTok = (entry.input_cost_per_token ?? 0) * 1_000_000;
  const outputPerMTok = (entry.output_cost_per_token ?? 0) * 1_000_000;
  const pricing: ModelPricing = { inputPerMTok, outputPerMTok };
  if (typeof entry.cache_creation_input_token_cost === 'number') {
    pricing.cacheCreate5mPerMTok = entry.cache_creation_input_token_cost * 1_000_000;
  }
  if (typeof entry.cache_creation_input_token_cost_above_1hr === 'number') {
    pricing.cacheCreate1hPerMTok = entry.cache_creation_input_token_cost_above_1hr * 1_000_000;
  }
  if (typeof entry.cache_read_input_token_cost === 'number') {
    pricing.cacheReadPerMTok = entry.cache_read_input_token_cost * 1_000_000;
  }
  return pricing;
}

function lookupLiteLLM(modelId: string): ModelPricing | undefined {
  // LiteLLM keys are sometimes bare (`claude-sonnet-4-5`), sometimes
  // provider-prefixed (`anthropic/claude-…`, `openai/gpt-…`). Claude JSONL
  // transcripts emit bare ids; try a small set of variants.
  const candidates = new Set<string>([modelId]);

  // Strip a leading `provider/` segment if present.
  const slashIdx = modelId.indexOf('/');
  if (slashIdx > 0) candidates.add(modelId.slice(slashIdx + 1));

  // If the id is bare, try common provider prefixes that LiteLLM uses.
  if (!modelId.includes('/')) {
    candidates.add(`anthropic/${modelId}`);
  }

  for (const key of candidates) {
    const entry = litellmTable[key];
    if (isLiteLLMEntry(entry)) return fromLiteLLM(entry);
  }
  return undefined;
}

/**
 * Try to load the userData-cached pricing JSON. Falls back to the bundled
 * import if the cache is missing or invalid. Safe to call repeatedly —
 * each call replaces the active table.
 *
 * Pass an explicit `userDataDir` for tests; production uses
 * `app.getPath('userData')` resolved by the caller.
 */
export function loadPrices(userDataDir: string): void {
  pricingCache.clear();
  warnedModels.clear();

  const cachePath = path.join(userDataDir, 'litellm-prices.json');
  try {
    const raw = fs.readFileSync(cachePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      litellmTable = parsed as Record<string, unknown>;
      log.info('using cached LiteLLM pricing', { path: cachePath });
      return;
    }
    log.warn('cached pricing JSON is not an object, falling back to bundled');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== 'ENOENT') {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('failed to read cached pricing, using bundled', { error: message });
    }
  }

  litellmTable = litellmPricesBundled as Record<string, unknown>;
}

/**
 * Reload from disk and clear the resolved-pricing cache. Called by
 * `pricing-fetcher.ts` after a successful 200 so subsequent lookups in
 * the current process see the new data; live cost views do not repaint.
 */
export function reloadPrices(): void {
  // Resolve userData lazily — `electron` is awkward to import at the top
  // of a module used in tests. The caller in production passes through
  // `loadPrices` once at startup; this convenience reload covers the
  // post-fetch case.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electron = require('electron') as typeof import('electron');
  loadPrices(electron.app.getPath('userData'));
}

export function getModelPricing(modelId: string): ModelPricing {
  const cached = pricingCache.get(modelId);
  if (cached) return cached;

  const fromTable = lookupLiteLLM(modelId);
  if (fromTable) {
    pricingCache.set(modelId, fromTable);
    return fromTable;
  }

  for (const [prefix, pricing] of PREFIX_PRICING) {
    if (modelId.startsWith(prefix)) {
      pricingCache.set(modelId, pricing);
      return pricing;
    }
  }

  if (!warnedModels.has(modelId)) {
    warnedModels.add(modelId);
    log.warn('Unknown model, using default pricing', { model: modelId });
  }
  pricingCache.set(modelId, DEFAULT_PRICING);
  return DEFAULT_PRICING;
}

/**
 * Calculate API-equivalent cost for a single assistant message.
 * All token counts are raw integers from the JSONL usage block.
 * Returns cost in USD.
 */
export function calculateMessageCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreate5m: number,
  cacheCreate1h: number,
  cacheReadTokens: number,
): number {
  const pricing = getModelPricing(model);
  const inputRate = pricing.inputPerMTok / 1_000_000;
  const outputRate = pricing.outputPerMTok / 1_000_000;

  const cacheCreate5mRate = pricing.cacheCreate5mPerMTok !== undefined
    ? pricing.cacheCreate5mPerMTok / 1_000_000
    : inputRate * 1.25;
  // LiteLLM has no 1h-cache field on most entries — always fall back to
  // input × 2.0 when absent (matches Anthropic's published ratio).
  const cacheCreate1hRate = pricing.cacheCreate1hPerMTok !== undefined
    ? pricing.cacheCreate1hPerMTok / 1_000_000
    : inputRate * 2.0;
  const cacheReadRate = pricing.cacheReadPerMTok !== undefined
    ? pricing.cacheReadPerMTok / 1_000_000
    : inputRate * 0.1;

  return (
    inputTokens * inputRate +
    cacheCreate5m * cacheCreate5mRate +
    cacheCreate1h * cacheCreate1hRate +
    cacheReadTokens * cacheReadRate +
    outputTokens * outputRate
  );
}
