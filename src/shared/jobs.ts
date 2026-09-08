import type { JobsSettings } from './types';

export const JOBS_DEFAULT_URL = 'http://localhost:8780';
export const DEFAULT_JOBS_SETTINGS: JobsSettings = {
  enabled: 'off', url: JOBS_DEFAULT_URL, token: '', path: '',
  shareRemoteSessions: false, autoLaunch: false,
};

export function normalizeJobsUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim() || JOBS_DEFAULT_URL); } catch {
    throw new Error('Enter a valid JOBS URL, such as http://localhost:8780.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTP or HTTPS server URL without credentials, a query, or a fragment.');
  }
  let normalized = url.toString();
  while (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return normalized;
}

export function isJobsLoopback(url: URL): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}
