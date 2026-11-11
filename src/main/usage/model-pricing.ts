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

/** Where a model's price came from. `sibling` and `default` are approximations. */
export type ModelPricingSource = 'table' | 'sibling' | 'prefix' | 'default' | 'none';

const ZERO_PRICING: ModelPricing = { inputPerMTok: 0, outputPerMTok: 0 };

const warnedModels = new Set<string>();
const pricingCache = new Map<string, ModelPricing>();
const sourceCache = new Map<string, ModelPricingSource>();
/** Priced table keys with no `provider/` segment; built on first sibling lookup. */
let bareKeyIndex: string[] | null = null;

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

const DATE_SEGMENT_RE = /^\d{8}$/;
const NUMERIC_SEGMENT_RE = /^\d+(\.\d+)?$/;

function pricedBareKeys(): string[] {
  bareKeyIndex ??= Object.keys(litellmTable)
    .filter(key => !key.includes('/') && isLiteLLMEntry(litellmTable[key]));
  return bareKeyIndex;
}

/** Drop a trailing `-YYYYMMDD` or `-YYYY-MM-DD` release date. */
function withoutReleaseDate(segments: string[]): string[] {
  const n = segments.length;
  if (n > 1 && DATE_SEGMENT_RE.test(segments[n - 1])) return segments.slice(0, -1);
  if (n > 3 && /^\d{4}$/.test(segments[n - 3]) && /^\d{2}$/.test(segments[n - 2]) && /^\d{2}$/.test(segments[n - 1])) {
    return segments.slice(0, -3);
  }
  return segments;
}

/** Numbers compare as numbers and outrank tags; tags compare as text. */
function compareVersionSegment(left: string, right: string): number {
  if (left === right) return 0;
  const leftNumber = NUMERIC_SEGMENT_RE.test(left) ? Number(left) : null;
  const rightNumber = NUMERIC_SEGMENT_RE.test(right) ? Number(right) : null;
  if (leftNumber !== null && rightNumber !== null) return leftNumber - rightNumber;
  if (leftNumber !== null) return 1;
  if (rightNumber !== null) return -1;
  return left < right ? -1 : 1;
}

/**
 * Order ids by version: numeric segments compare as numbers and outrank
 * tags, and a release date never makes an older version look newer.
 */
function compareVersionOrder(a: string, b: string): number {
  const left = withoutReleaseDate(a.split('-'));
  const right = withoutReleaseDate(b.split('-'));
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const order = compareVersionSegment(left[i], right[i]);
    if (order !== 0) return order;
  }
  if (left.length !== right.length) return left.length - right.length;
  // Same version: prefer the undated key.
  return b.length - a.length;
}

/** The newest priced bare key that is `stem` itself or one of its versions. */
function newestListedVersion(stem: string): string | undefined {
  const prefix = `${stem}-`;
  let best: string | undefined;
  for (const key of pricedBareKeys()) {
    if (key !== stem && !key.startsWith(prefix)) continue;
    if (best === undefined || compareVersionOrder(key, best) > 0) best = key;
  }
  return best;
}

/**
 * Price a model the table does not list yet from the newest listed version
 * of the same family. A release usually reaches the table days after it
 * reaches the CLI; without this the model falls through to DEFAULT_PRICING,
 * which can be several times too low.
 *
 * The family is found by dropping trailing `-segments` one at a time, never
 * below two segments, so `claude-fable-5-2` can borrow from `claude-fable-5-1`
 * but never from another family. Only bare keys are considered:
 * provider-qualified keys carry that provider's markup.
 */
function lookupSibling(modelId: string): { pricing: ModelPricing; sibling: string; exact: boolean } | undefined {
  const slash = modelId.indexOf('/');
  const unqualified = slash > 0 ? modelId.slice(slash + 1) : modelId;
  const suffix = unqualified.search(/[@:]/);
  const bare = suffix >= 0 ? unqualified.slice(0, suffix) : unqualified;
  const segments = withoutReleaseDate(bare.split('-'));
  const undated = segments.join('-');

  // A dated or suffixed id for a listed model is that model, not a sibling.
  if (undated !== modelId) {
    const entry = litellmTable[undated];
    if (isLiteLLMEntry(entry)) return { pricing: fromLiteLLM(entry), sibling: undated, exact: true };
  }

  for (let count = segments.length - 1; count >= 2; count--) {
    const best = newestListedVersion(segments.slice(0, count).join('-'));
    if (best !== undefined) {
      return { pricing: fromLiteLLM(litellmTable[best] as LiteLLMEntry), sibling: best, exact: false };
    }
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
  sourceCache.clear();
  warnedModels.clear();
  bareKeyIndex = null;

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

function remember(modelId: string, pricing: ModelPricing, source: ModelPricingSource): ModelPricing {
  pricingCache.set(modelId, pricing);
  sourceCache.set(modelId, source);
  return pricing;
}

export function getModelPricing(modelId: string): ModelPricing {
  const cached = pricingCache.get(modelId);
  if (cached) return cached;

  // Claude Code writes zero-token `<synthetic>` records; they have no price.
  if (!modelId.trim() || modelId === '<synthetic>') return remember(modelId, ZERO_PRICING, 'none');

  const fromTable = lookupLiteLLM(modelId);
  if (fromTable) return remember(modelId, fromTable, 'table');

  const fromSibling = lookupSibling(modelId);
  if (fromSibling) {
    if (!fromSibling.exact && !warnedModels.has(modelId)) {
      warnedModels.add(modelId);
      log.info('Model not in pricing table, using nearest sibling', { model: modelId, sibling: fromSibling.sibling });
    }
    return remember(modelId, fromSibling.pricing, fromSibling.exact ? 'table' : 'sibling');
  }

  for (const [prefix, pricing] of PREFIX_PRICING) {
    if (modelId.startsWith(prefix)) return remember(modelId, pricing, 'prefix');
  }

  if (!warnedModels.has(modelId)) {
    warnedModels.add(modelId);
    log.warn('Unknown model, using default pricing', { model: modelId });
  }
  return remember(modelId, DEFAULT_PRICING, 'default');
}

/** How `getModelPricing` priced this model, so callers can label approximations. */
export function getModelPricingSource(modelId: string): ModelPricingSource {
  getModelPricing(modelId);
  return sourceCache.get(modelId) ?? 'default';
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
