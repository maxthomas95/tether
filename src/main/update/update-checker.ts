// TODO: Replace with electron-updater for full auto-update when code signing is implemented.

import { app } from 'electron';
import { createLogger } from '../logger';
import type { UpdateCheckResult } from '../../shared/types';

const log = createLogger('update');

const GITHUB_API = 'https://api.github.com/repos/maxthomas95/tether/releases';

/**
 * Compare two semver strings (major.minor.patch).
 * Returns 1 if a > b, -1 if a < b, 0 if equal.
 */
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

/**
 * Extract base semver (e.g. "0.3.0") from a tag like "v0.3.0-alpha.1".
 * Returns null if the tag doesn't match.
 */
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

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion();
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

    const res = await fetch(GITHUB_API, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      log.warn(`GitHub API returned ${res.status}`);
      return empty;
    }

    const releases: GitHubRelease[] = await res.json();

    // Filter out drafts and prereleases, then find the highest version
    const candidates = releases
      .filter(r => !r.draft && !r.prerelease)
      .map(r => ({ ...r, version: parseVersion(r.tag_name) }))
      .filter((r): r is typeof r & { version: string } => r.version !== null);

    if (candidates.length === 0) return empty;

    candidates.sort((a, b) => compareSemver(b.version, a.version));
    const latest = candidates[0];

    return {
      updateAvailable: compareSemver(latest.version, currentVersion) > 0,
      latestVersion: latest.version,
      latestTag: latest.tag_name,
      releaseUrl: latest.html_url,
      currentVersion,
    };
  } catch (err) {
    log.warn('Update check failed', { error: err instanceof Error ? err.message : String(err) });
    return empty;
  }
}
