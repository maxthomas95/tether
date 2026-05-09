export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
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
