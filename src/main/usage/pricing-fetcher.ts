import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { createLogger } from '../logger';
import { reloadPrices } from './model-pricing';

const log = createLogger('pricing-fetcher');

// LiteLLM publishes pricing as a single JSON file in their main branch. We
// hit the raw.githubusercontent.com endpoint to skip the GitHub API rate
// limit (the file is ~1.4 MB). Hard-coded — never read from user config or
// IPC; the URL is part of the trust boundary.
const URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

// Cache file names live alongside the bundled JSON; the actual cache lives
// in {userData} so it survives app updates.
const CACHE_FILE = 'litellm-prices.json';
const META_FILE = 'litellm-prices-meta.json';

// Skip the network entirely if the last successful fetch was within this
// window. Users still get fresh data on every app launch beyond a day old.
const THROTTLE_MS = 24 * 60 * 60 * 1000;

// Cap response size to defend against intermediary proxies returning HTML
// or otherwise pathological payloads. The current LiteLLM file is ~1.4 MB.
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

// Network/parse timeout. Background work — never wait long.
const REQUEST_TIMEOUT_MS = 15_000;

// Sentinel keys we expect any valid LiteLLM dump to contain. If none match,
// we treat the response as corrupt and don't write it. Cheap defence
// against captive-portal HTML or proxies serving an empty JSON object.
const SENTINEL_KEYS = [
  'claude-sonnet-4-5',
  'claude-3-5-sonnet-20241022',
  'claude-opus-4-5',
  'gpt-4o',
];

interface PricingMeta {
  lastFetched: number;
  etag: string | null;
}

interface FetchResult {
  status: number;
  body: Buffer;
  etag: string | null;
}

function cachePath(name: string): string {
  return path.join(app.getPath('userData'), name);
}

async function readMeta(): Promise<PricingMeta | null> {
  try {
    const raw = await fs.readFile(cachePath(META_FILE), 'utf8');
    const parsed = JSON.parse(raw) as Partial<PricingMeta>;
    if (typeof parsed.lastFetched !== 'number') return null;
    return {
      lastFetched: parsed.lastFetched,
      etag: typeof parsed.etag === 'string' ? parsed.etag : null,
    };
  } catch {
    return null;
  }
}

async function writeMeta(meta: PricingMeta): Promise<void> {
  await fs.writeFile(cachePath(META_FILE), JSON.stringify(meta, null, 2), 'utf8');
}

function fetchOnce(etag: string | null): Promise<FetchResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const headers: Record<string, string> = {
      'User-Agent': 'tether-app',
      Accept: 'application/json',
    };
    if (etag) headers['If-None-Match'] = etag;

    const req = https.get(URL, { headers, timeout: REQUEST_TIMEOUT_MS }, (res) => {
      const status = res.statusCode ?? 0;
      const responseEtag = typeof res.headers.etag === 'string' ? res.headers.etag : null;

      // 304 Not Modified — no body, nothing to validate.
      if (status === 304) {
        res.resume();
        resolvePromise({ status, body: Buffer.alloc(0), etag: responseEtag });
        return;
      }

      const chunks: Buffer[] = [];
      let received = 0;
      let aborted = false;
      res.on('data', (chunk: Buffer) => {
        if (aborted) return;
        received += chunk.length;
        if (received > MAX_RESPONSE_BYTES) {
          aborted = true;
          req.destroy(new Error(`response exceeded ${MAX_RESPONSE_BYTES} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (aborted) return;
        resolvePromise({ status, body: Buffer.concat(chunks), etag: responseEtag });
      });
      res.on('error', rejectPromise);
    });

    req.on('timeout', () => {
      req.destroy(new Error('request timed out'));
    });
    req.on('error', rejectPromise);
  });
}

function looksLikeLiteLLMTable(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return SENTINEL_KEYS.some((key) => key in obj);
}

/**
 * Background pricing refresh. Never throws; logs warnings on failure and
 * leaves the cache untouched, so the bundled JSON keeps driving cost
 * calculations.
 */
export async function refreshPricesInBackground(): Promise<void> {
  try {
    const meta = await readMeta();
    const now = Date.now();
    if (meta && now - meta.lastFetched < THROTTLE_MS) {
      log.debug('skipping refresh — within throttle window', {
        ageMs: now - meta.lastFetched,
      });
      return;
    }

    log.info('checking LiteLLM for pricing updates');
    const result = await fetchOnce(meta?.etag ?? null);

    if (result.status === 304) {
      log.info('pricing unchanged (304)');
      await writeMeta({ lastFetched: now, etag: meta?.etag ?? null });
      return;
    }

    if (result.status !== 200) {
      log.warn('unexpected status from pricing source', { status: result.status });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.body.toString('utf8'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('pricing response is not valid JSON', { error: message });
      return;
    }

    if (!looksLikeLiteLLMTable(parsed)) {
      log.warn('pricing response missing sentinel keys, ignoring');
      return;
    }

    await fs.writeFile(cachePath(CACHE_FILE), result.body);
    await writeMeta({ lastFetched: now, etag: result.etag });
    log.info('pricing updated', { bytes: result.body.length });

    // Invalidate the in-memory cache; next session pickup will use the
    // refreshed table. We don't attempt to repaint live cost views.
    reloadPrices();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('pricing refresh failed', { error: message });
  }
}

/** Path to the cached pricing JSON, for callers that want to read it. */
export function getCachedPricingPath(): string {
  return cachePath(CACHE_FILE);
}
