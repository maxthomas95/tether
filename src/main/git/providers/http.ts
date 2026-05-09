export function normalizeBaseUrl(baseUrl: string): string {
  // Trailing-slash trimming via while-loop, not regex: Sonar flags `/\/+$/`
  // as S5852 (ReDoS) on new code — same fix as github-client's earlier sweep.
  let normalized = baseUrl;
  while (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
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
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${apiName} API ${res.status}: ${text || res.statusText}`);
  }
  return res.json() as Promise<T>;
}
