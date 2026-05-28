import net from 'node:net';

const PRIVATE_IPV4_RANGES: ReadonlyArray<[number, number]> = [
  [0x0a000000, 0xff000000],
  [0xac100000, 0xfff00000],
  [0xc0a80000, 0xffff0000],
  [0xa9fe0000, 0xffff0000],
  [0x7f000000, 0xff000000],
  [0x00000000, 0xff000000],
];

function ipv4ToInt(host: string): number | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    out = (out << 8) + n;
  }
  return out >>> 0;
}

function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  const ipKind = net.isIP(host);
  if (ipKind === 4) {
    const ip = ipv4ToInt(host);
    return ip !== null && PRIVATE_IPV4_RANGES.some(([base, mask]) => ((ip & mask) >>> 0) === base);
  }
  if (ipKind === 6) {
    return host === '::1'
      || host === '0:0:0:0:0:0:0:1'
      || host === '::'
      || host.startsWith('fc')
      || host.startsWith('fd')
      || host.startsWith('fe80:');
  }
  return false;
}

export function normalizeBaseUrl(baseUrl: string): string {
  let normalized = baseUrl.trim();
  while (normalized.endsWith('/')) normalized = normalized.slice(0, -1);

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error('Git provider base URL must be a valid HTTPS URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Git provider base URL must use HTTPS');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Git provider base URL must not embed credentials');
  }
  if (isBlockedHost(parsed.hostname)) {
    throw new Error('Git provider base URL host is not allowed');
  }
  return normalized;
}

interface JsonRequestOptions {
  headers: Record<string, string>;
  method?: 'GET' | 'POST';
  body?: unknown;
}

export async function requestJson<T>(
  url: string,
  apiName: string,
  { headers, method = 'GET', body }: JsonRequestOptions,
): Promise<T> {
  const requestHeaders = body === undefined
    ? headers
    : { ...headers, 'Content-Type': 'application/json' };
  const res = await fetch(url, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${apiName} API ${res.status}: ${text || res.statusText}`);
  }
  return res.json() as Promise<T>;
}
