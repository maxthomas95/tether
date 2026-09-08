import { getDb, saveDb } from '../db/database';
import { decryptSecretFromStorage, encryptSecretForStorage } from '../db/secret-storage';
import { JOBS_DEFAULT_URL, isJobsLoopback, normalizeJobsUrl } from '../../shared/jobs';
import type { JobsSettings } from '../../shared/types';

const KEYS = ['jobsUrl', 'jobsToken', 'jobsPath', 'jobsShareRemoteSessions', 'jobsAutoLaunch'];

export function readJobsConfig(readToken = true): JobsSettings {
  const cfg = getDb().config;
  // Preserve explicitly saved setups. A fresh install never probes or shares.
  const enabled = cfg.jobsEnabled === 'auto' ? 'auto' : 'off';
  return {
    enabled,
    url: cfg.jobsUrl || JOBS_DEFAULT_URL,
    token: readToken && cfg.jobsToken ? decryptSecretFromStorage(cfg.jobsToken, 'JOBS token') : '',
    path: cfg.jobsPath || '',
    shareRemoteSessions: cfg.jobsShareRemoteSessions === undefined
      ? enabled === 'auto' : cfg.jobsShareRemoteSessions === 'true',
    autoLaunch: cfg.jobsAutoLaunch === undefined ? !!cfg.jobsPath : cfg.jobsAutoLaunch === 'true',
  };
}

export function saveJobsConfig(input: JobsSettings): void {
  if (!input || !['auto', 'off'].includes(input.enabled) ||
      typeof input.url !== 'string' || typeof input.token !== 'string' || typeof input.path !== 'string' ||
      typeof input.shareRemoteSessions !== 'boolean' || typeof input.autoLaunch !== 'boolean') {
    throw new Error('Invalid JOBS settings.');
  }
  const url = normalizeJobsUrl(input.url);
  const folder = input.path.trim();
  if (input.enabled === 'auto' && input.autoLaunch) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' || !isJobsLoopback(parsed) || parsed.pathname !== '/') {
      throw new Error('Automatic launch needs a local HTTP URL without a path, such as http://localhost:8780.');
    }
    if (!folder) throw new Error('Choose a built JOBS folder, or turn off automatic launch.');
  }
  // Encrypt and validate everything before mutating the database.
  const token = encryptSecretForStorage(input.token.trim(), 'JOBS token');
  writeConfig({
    ...getDb().config, jobsEnabled: input.enabled, jobsUrl: url, jobsToken: token, jobsPath: folder,
    jobsShareRemoteSessions: String(input.shareRemoteSessions), jobsAutoLaunch: String(input.autoLaunch),
  });
}

export function disableJobsConfig(remove = false): void {
  const next: Record<string, string> = { ...getDb().config, jobsEnabled: 'off' };
  if (remove) for (const key of KEYS) delete next[key];
  else if (next.jobsShareRemoteSessions === undefined) {
    next.jobsShareRemoteSessions = String(getDb().config.jobsEnabled === 'auto');
  }
  writeConfig(next);
}

function writeConfig(next: Record<string, string>): void {
  const db = getDb();
  const previous = db.config;
  db.config = next;
  try { saveDb(); } catch (error) { db.config = previous; throw error; }
}
