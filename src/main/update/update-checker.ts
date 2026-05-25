// TODO: Replace with electron-updater for full auto-update when code signing is implemented.

import { app } from 'electron';
import { createLogger } from '../logger';
import type { UpdateCheckResult } from '../../shared/types';

const log = createLogger('update');

const GITHUB_API = 'https://api.github.com/repos/maxthomas95/tether/releases';

export type UpdateChannel = 'stable' | 'beta';

interface ParsedVersion {
  base: string;        // e.g. "0.7.0"
  preTag: string;      // e.g. "beta" or "" for stable
  preNum: number;      // e.g. 2 from "-beta.2", or Infinity for stable
}

function parseVersionFull(tag: string): ParsedVersion | null {
  const m = tag.match(/^v?(\d+\.\d+\.\d+)(?:-([\w]+)\.(\d+))?/);
  if (!m) return null;
  return {
    base: m[1],
    preTag: m[2] ?? '',
    preNum: m[3] !== undefined ? Number(m[3]) : Infinity,
  };
}

/**
 * Compare two parsed versions. Stable (no pre-release suffix) is always
 * newer than a pre-release of the same base version.
 * Returns 1 if a > b, -1 if a < b, 0 if equal.
 */
function compareParsed(a: ParsedVersion, b: ParsedVersion): number {
  const pa = a.base.split('.').map(Number);
  const pb = b.base.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  // Same base — Infinity (stable) beats any finite pre-release number
  if (a.preNum > b.preNum) return 1;
  if (a.preNum < b.preNum) return -1;
  return 0;
}

function parseVersion(tag: string): string | null {
  const m = tag.match(/^v?(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

interface GitHubRelease {
  tag_name: string;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
}

export async function checkForUpdates(channel: UpdateChannel = 'stable'): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion();
  const currentParsed = parseVersionFull(currentVersion);
  const empty: UpdateCheckResult = {
    updateAvailable: false,
    latestVersion: currentVersion,
    latestTag: `v${currentVersion}`,
    releaseUrl: '',
    currentVersion,
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let res: Response;
    try {
      res = await fetch(GITHUB_API, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      log.warn(`GitHub API returned ${res.status}`);
      return { ...empty, error: `GitHub Releases returned HTTP ${res.status}.` };
    }

    const releases: GitHubRelease[] = await res.json();

    const candidates = releases
      .filter(r => !r.draft && (channel === 'beta' || !r.prerelease))
      .map(r => ({ ...r, parsed: parseVersionFull(r.tag_name) }))
      .filter((r): r is typeof r & { parsed: ParsedVersion } => r.parsed !== null);

    if (candidates.length === 0) return empty;

    candidates.sort((a, b) => compareParsed(b.parsed, a.parsed));
    const latest = candidates[0];
    const latestVersion = parseVersion(latest.tag_name) ?? latest.parsed.base;

    const isNewer = currentParsed
      ? compareParsed(latest.parsed, currentParsed) > 0
      : latestVersion > currentVersion;

    return {
      updateAvailable: isNewer,
      latestVersion,
      latestTag: latest.tag_name,
      releaseUrl: latest.html_url,
      currentVersion,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('Update check failed', { error: message });
    const error = message.toLowerCase().includes('abort') ? 'Update check timed out after 10 seconds.' : `Could not reach GitHub Releases: ${message}`;
    return { ...empty, error };
  }
}
