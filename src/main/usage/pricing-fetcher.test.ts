import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  userData: '',
  get: vi.fn(),
  reloadPrices: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('electron', () => ({ app: { getPath: () => mocks.userData } }));
vi.mock('node:https', () => ({ default: { get: mocks.get } }));
vi.mock('./model-pricing', () => ({ reloadPrices: mocks.reloadPrices }));
vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mocks.warn, error: vi.fn() }),
}));

import { getCachedPricingPath, refreshPricesInBackground } from './pricing-fetcher';

const DAY_MS = 24 * 60 * 60 * 1000;
const TABLE = JSON.stringify({ 'gpt-4o': { input_cost_per_token: 1 } });

interface Reply { status: number; body?: string | Buffer[]; etag?: string }

/** Answer the next request with `reply`, or leave it pending for the test to drive. */
function respondWith(reply: Reply | null) {
  const request = Object.assign(new EventEmitter(), {
    destroy(error: Error) { request.emit('error', error); },
  });
  mocks.get.mockImplementationOnce((_url: string, _options: unknown, onResponse: (res: unknown) => void) => {
    // A real response arrives after get() has returned the request.
    if (reply) setImmediate(() => {
      const response = Object.assign(new EventEmitter(), {
        statusCode: reply.status,
        headers: reply.etag ? { etag: reply.etag } : {},
        resume: vi.fn(),
      });
      onResponse(response);
      const chunks = typeof reply.body === 'string' ? [Buffer.from(reply.body)] : reply.body ?? [];
      for (const chunk of chunks) response.emit('data', chunk);
      response.emit('end');
    });
    return request;
  });
  return request;
}

const metaPath = () => path.join(mocks.userData, 'litellm-prices-meta.json');
const readMeta = () => JSON.parse(fs.readFileSync(metaPath(), 'utf8')) as { lastFetched: number; etag: string | null };
const requestHeaders = () => (mocks.get.mock.calls[0][1] as { headers: Record<string, string> }).headers;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-pricing-'));
});

afterEach(() => {
  fs.rmSync(mocks.userData, { recursive: true, force: true });
});

describe('background pricing refresh', () => {
  it('caches a valid table with its etag and reloads prices', async () => {
    respondWith({ status: 200, body: TABLE, etag: '"v1"' });

    await refreshPricesInBackground();

    expect(mocks.get.mock.calls[0][0]).toMatch(/^https:\/\/raw\.githubusercontent\.com\/BerriAI\/litellm\//);
    expect(requestHeaders()).not.toHaveProperty('If-None-Match');
    expect(fs.readFileSync(getCachedPricingPath(), 'utf8')).toBe(TABLE);
    expect(readMeta().etag).toBe('"v1"');
    expect(mocks.reloadPrices).toHaveBeenCalledOnce();
  });

  it('skips the network when the last fetch was under a day ago', async () => {
    fs.writeFileSync(metaPath(), JSON.stringify({ lastFetched: Date.now() - 1000, etag: '"v1"' }));

    await refreshPricesInBackground();

    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('revalidates a stale cache with its etag and keeps it on 304', async () => {
    const stale = Date.now() - 2 * DAY_MS;
    fs.writeFileSync(metaPath(), JSON.stringify({ lastFetched: stale, etag: '"v1"' }));
    respondWith({ status: 304 });

    await refreshPricesInBackground();

    expect(requestHeaders()['If-None-Match']).toBe('"v1"');
    expect(readMeta()).toMatchObject({ etag: '"v1"' });
    expect(readMeta().lastFetched).toBeGreaterThan(stale);
    expect(fs.existsSync(getCachedPricingPath())).toBe(false);
    expect(mocks.reloadPrices).not.toHaveBeenCalled();
  });

  it('treats unreadable metadata as never fetched', async () => {
    fs.writeFileSync(metaPath(), JSON.stringify({ lastFetched: 'yesterday' }));
    respondWith({ status: 304 });

    await refreshPricesInBackground();

    expect(mocks.get).toHaveBeenCalledOnce();
    expect(requestHeaders()).not.toHaveProperty('If-None-Match');
    expect(readMeta().etag).toBeNull();
  });

  it.each([
    ['an error status', { status: 503, body: 'unavailable' }],
    ['a captive-portal page', { status: 200, body: '<html>Sign in</html>' }],
    ['JSON that is not a price table', { status: 200, body: '{"unrelated":true}' }],
    ['a JSON scalar', { status: 200, body: 'null' }],
  ])('leaves the cache untouched after %s', async (_name, reply) => {
    respondWith(reply);

    await refreshPricesInBackground();

    expect(fs.existsSync(getCachedPricingPath())).toBe(false);
    expect(fs.existsSync(metaPath())).toBe(false);
    expect(mocks.reloadPrices).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledOnce();
  });

  it('abandons a response larger than the size cap', async () => {
    const megabyte = Buffer.alloc(1024 * 1024, 0x20);
    respondWith({ status: 200, body: Array.from({ length: 6 }, () => megabyte) });

    await refreshPricesInBackground();

    expect(mocks.warn).toHaveBeenCalledWith('pricing refresh failed', { error: expect.stringContaining('exceeded') });
    expect(fs.existsSync(getCachedPricingPath())).toBe(false);
  });

  it('never rejects when the request times out or the network fails', async () => {
    const timedOut = respondWith(null);
    const first = refreshPricesInBackground();
    await vi.waitFor(() => expect(mocks.get).toHaveBeenCalledOnce());
    timedOut.emit('timeout');
    await expect(first).resolves.toBeUndefined();
    expect(mocks.warn).toHaveBeenLastCalledWith('pricing refresh failed', { error: 'request timed out' });

    const offline = respondWith(null);
    const second = refreshPricesInBackground();
    await vi.waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
    offline.emit('error', new Error('getaddrinfo ENOTFOUND'));
    await expect(second).resolves.toBeUndefined();
    expect(mocks.warn).toHaveBeenLastCalledWith('pricing refresh failed', { error: 'getaddrinfo ENOTFOUND' });
  });
});
