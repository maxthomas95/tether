import { createLogger } from '../logger';

const log = createLogger('pricing');

export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

/**
 * Embedded pricing table — per million tokens, USD.
 * Cache costs are derived from input rates:
 *   cache_create (5m TTL) = input × 1.25
 *   cache_create (1h TTL) = input × 2.0
 *   cache_read             = input × 0.1
 */
const PRICING: Record<string, ModelPricing> = {
  // Opus family
  'claude-opus-4-6':              { inputPerMTok: 5,  outputPerMTok: 25 },
  'claude-opus-4-5-20251101':     { inputPerMTok: 5,  outputPerMTok: 25 },
  'claude-opus-4-5':              { inputPerMTok: 5,  outputPerMTok: 25 },
  // Sonnet family
  'claude-sonnet-4-6':            { inputPerMTok: 3,  outputPerMTok: 15 },
  'claude-sonnet-4-5-20241022':   { inputPerMTok: 3,  outputPerMTok: 15 },
  'claude-sonnet-4-5':            { inputPerMTok: 3,  outputPerMTok: 15 },
  // Haiku family
  'claude-haiku-4-5-20251001':    { inputPerMTok: 1,  outputPerMTok: 5  },
  'claude-haiku-4-5':             { inputPerMTok: 1,  outputPerMTok: 5  },
};

// Prefix-based fallback for models not in the exact table
const PREFIX_PRICING: Array<[string, ModelPricing]> = [
  ['claude-opus',   { inputPerMTok: 5,  outputPerMTok: 25 }],
  ['claude-sonnet', { inputPerMTok: 3,  outputPerMTok: 15 }],
  ['claude-haiku',  { inputPerMTok: 1,  outputPerMTok: 5  }],
];

const DEFAULT_PRICING: ModelPricing = { inputPerMTok: 3, outputPerMTok: 15 };

const warnedModels = new Set<string>();

export function getModelPricing(modelId: string): ModelPricing {
  const exact = PRICING[modelId];
  if (exact) return exact;

  for (const [prefix, pricing] of PREFIX_PRICING) {
    if (modelId.startsWith(prefix)) return pricing;
  }

  if (!warnedModels.has(modelId)) {
    warnedModels.add(modelId);
    log.warn('Unknown model, using default pricing', { model: modelId });
  }
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

  return (
    inputTokens * inputRate +
    cacheCreate5m * inputRate * 1.25 +
    cacheCreate1h * inputRate * 2.0 +
    cacheReadTokens * inputRate * 0.1 +
    outputTokens * outputRate
  );
}
