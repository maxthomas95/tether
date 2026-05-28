import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { normalizeBaseUrl, requestJson } from './http';

describe('git provider HTTP helpers', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '',
      json: async () => ({ ok: true }),
    })) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('normalizes public HTTPS provider URLs', () => {
    expect(normalizeBaseUrl('https://api.github.com///')).toBe('https://api.github.com');
  });

  it('rejects unsafe provider base URLs before tokens are attached', () => {
    expect(() => normalizeBaseUrl('http://github.com')).toThrow(/HTTPS/);
    expect(() => normalizeBaseUrl('https://localhost')).toThrow(/not allowed/);
    expect(() => normalizeBaseUrl('https://127.0.0.1')).toThrow(/not allowed/);
    expect(() => normalizeBaseUrl('https://10.0.0.5')).toThrow(/not allowed/);
    expect(() => normalizeBaseUrl('https://169.254.169.254')).toThrow(/not allowed/);
    expect(() => normalizeBaseUrl('https://token@example.com')).toThrow(/credentials/);
  });

  it('disables redirects on authenticated requests', async () => {
    await requestJson('https://api.github.com/user', 'GitHub', {
      headers: { Authorization: 'Bearer token' },
    });
    expect(globalThis.fetch).toHaveBeenCalledWith('https://api.github.com/user', expect.objectContaining({
      redirect: 'error',
    }));
  });
});

