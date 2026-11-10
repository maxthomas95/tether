import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logMocks = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
vi.mock('../logger', () => ({ createLogger: () => logMocks }));

import { getModelPricing, getModelPricingSource, loadPrices } from './model-pricing';

interface Rates { input: number; output: number; cacheRead?: number }

function entry({ input, output, cacheRead }: Rates): Record<string, unknown> {
  return {
    litellm_provider: 'anthropic',
    input_cost_per_token: input / 1_000_000,
    output_cost_per_token: output / 1_000_000,
    ...(cacheRead === undefined ? {} : { cache_read_input_token_cost: cacheRead / 1_000_000 }),
  };
}

let directory: string;

function load(table: Record<string, unknown>): void {
  fs.writeFileSync(path.join(directory, 'litellm-prices.json'), JSON.stringify(table));
  loadPrices(directory);
}

function siblingLogs(): unknown[][] {
  return logMocks.info.mock.calls.filter(call => String(call[0]).includes('nearest sibling'));
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-pricing-'));
  logMocks.info.mockClear();
  logMocks.warn.mockClear();
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('getModelPricing', () => {
  it('uses the table entry for a listed model', () => {
    load({ 'claude-fable-5': entry({ input: 10, output: 50 }) });
    expect(getModelPricing('claude-fable-5')).toMatchObject({ inputPerMTok: 10, outputPerMTok: 50 });
    expect(getModelPricingSource('claude-fable-5')).toBe('table');
    expect(siblingLogs()).toEqual([]);
  });

  it('prices an unlisted version from the newest listed version of its family', () => {
    load({
      'claude-fable-5': entry({ input: 10, output: 50, cacheRead: 1 }),
      'claude-fable-5-1': entry({ input: 11, output: 55, cacheRead: 0.25 }),
      'claude-opus-5-5': entry({ input: 5, output: 25 }),
    });
    expect(getModelPricing('claude-fable-5-2')).toMatchObject({ inputPerMTok: 11, outputPerMTok: 55 });
    expect(getModelPricingSource('claude-fable-5-2')).toBe('sibling');
    // A new major version still borrows from its own family.
    expect(getModelPricing('claude-fable-6')).toMatchObject({ inputPerMTok: 11 });
  });

  it('falls back to the base version when it is the only one listed', () => {
    load({ 'claude-fable-5': entry({ input: 10, output: 50 }) });
    expect(getModelPricing('claude-fable-5-2')).toMatchObject({ inputPerMTok: 10, outputPerMTok: 50 });
  });

  it('treats a dated or suffixed id as the listed model itself', () => {
    load({
      'claude-fable-5': entry({ input: 10, output: 50 }),
      'claude-fable-5-1': entry({ input: 11, output: 55 }),
      'gpt-5.6-terra': entry({ input: 2, output: 8 }),
    });
    expect(getModelPricing('claude-fable-5-20261101')).toMatchObject({ inputPerMTok: 10 });
    expect(getModelPricingSource('claude-fable-5-20261101')).toBe('table');
    expect(getModelPricing('gpt-5.6-terra-2026-11-01')).toMatchObject({ inputPerMTok: 2 });
    expect(getModelPricing('claude-fable-5@default')).toMatchObject({ inputPerMTok: 10 });
    expect(siblingLogs()).toEqual([]);
  });

  it('does not let a release date outrank a newer version', () => {
    load({
      'claude-opus-4-20250514': entry({ input: 15, output: 75 }),
      'claude-opus-4-5': entry({ input: 5, output: 25 }),
      'claude-opus-4-5-20251101': entry({ input: 5, output: 25 }),
    });
    expect(getModelPricing('claude-opus-4-7')).toMatchObject({ inputPerMTok: 5, outputPerMTok: 25 });
  });

  it('never borrows from another family or a provider-qualified key', () => {
    load({
      'claude-fable-5': entry({ input: 10, output: 50 }),
      'claude-opus-5-5': entry({ input: 5, output: 25 }),
      'vertex_ai/claude-newfamily-1': entry({ input: 99, output: 99 }),
      'anthropic.claude-newfamily-1': entry({ input: 98, output: 98 }),
      'bedrock/claude-newfamily-latest': { litellm_provider: 'bedrock' },
    });
    expect(getModelPricing('claude-newfamily-2')).toEqual({ inputPerMTok: 3, outputPerMTok: 15 });
    expect(getModelPricingSource('claude-newfamily-2')).toBe('default');
    expect(logMocks.warn).toHaveBeenCalledWith('Unknown model, using default pricing', { model: 'claude-newfamily-2' });
  });

  it('keeps the static prefix fallback for a family with no listed version', () => {
    load({ 'claude-fable-5': entry({ input: 10, output: 50 }) });
    expect(getModelPricing('claude-haiku-9')).toMatchObject({ inputPerMTok: 1, outputPerMTok: 5 });
    expect(getModelPricingSource('claude-haiku-9')).toBe('prefix');
  });

  it('prices synthetic and empty ids at zero without logging', () => {
    load({ 'claude-fable-5': entry({ input: 10, output: 50 }) });
    expect(getModelPricing('<synthetic>')).toEqual({ inputPerMTok: 0, outputPerMTok: 0 });
    expect(getModelPricingSource('<synthetic>')).toBe('none');
    expect(getModelPricing('  ')).toEqual({ inputPerMTok: 0, outputPerMTok: 0 });
    expect(logMocks.warn).not.toHaveBeenCalled();
    expect(siblingLogs()).toEqual([]);
  });

  it('logs a sibling fallback once per model', () => {
    load({ 'claude-fable-5-1': entry({ input: 11, output: 55 }) });
    getModelPricing('claude-fable-5-2');
    getModelPricing('claude-fable-5-2');
    expect(siblingLogs()).toEqual([
      ['Model not in pricing table, using nearest sibling', { model: 'claude-fable-5-2', sibling: 'claude-fable-5-1' }],
    ]);
  });

  it('picks up a reloaded table', () => {
    load({ 'claude-fable-5': entry({ input: 10, output: 50 }) });
    expect(getModelPricing('claude-fable-5-2')).toMatchObject({ inputPerMTok: 10 });
    load({
      'claude-fable-5': entry({ input: 10, output: 50 }),
      'claude-fable-5-1': entry({ input: 11, output: 55 }),
    });
    expect(getModelPricing('claude-fable-5-2')).toMatchObject({ inputPerMTok: 11 });
    load({
      'claude-fable-5': entry({ input: 10, output: 50 }),
      'claude-fable-5-2': entry({ input: 12, output: 60 }),
    });
    expect(getModelPricing('claude-fable-5-2')).toMatchObject({ inputPerMTok: 12 });
    expect(getModelPricingSource('claude-fable-5-2')).toBe('table');
  });
});
