import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.6.0',
    getPath: () => process.cwd(),
  },
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

import { checkForUpdates } from './update-checker';

const fetchMock = vi.fn();
const failedResponse = { ok: false, status: 503 };

function makeRelease(tag: string, prerelease = false) {
  return {
    tag_name: tag,
    html_url: `https://github.com/maxthomas95/tether/releases/tag/${tag}`,
    draft: false,
    prerelease,
  };
}

function mockReleases(...releases: ReturnType<typeof makeRelease>[]) {
  fetchMock.mockResolvedValue({ ok: true, json: async () => releases });
}

describe('checkForUpdates', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('reports update availability from GitHub releases', async () => {
    mockReleases(makeRelease('v0.7.0'));

    const result = await checkForUpdates();

    expect(result.updateAvailable).toBe(true);
    expect(result.latestVersion).toBe('0.7.0');
    expect(result.error).toBeUndefined();
  });

  it('stable channel skips pre-releases', async () => {
    mockReleases(makeRelease('v0.7.0-beta.1', true), makeRelease('v0.5.0'));

    const result = await checkForUpdates('stable');

    expect(result.updateAvailable).toBe(false);
    expect(result.latestVersion).toBe('0.5.0');
  });

  it('beta channel includes pre-releases', async () => {
    mockReleases(makeRelease('v0.7.0-beta.1', true), makeRelease('v0.6.0'));

    const result = await checkForUpdates('beta');

    expect(result.updateAvailable).toBe(true);
    expect(result.latestVersion).toBe('0.7.0');
    expect(result.latestTag).toBe('v0.7.0-beta.1');
  });

  it('beta channel orders beta.2 above beta.1', async () => {
    mockReleases(
      makeRelease('v0.7.0-beta.1', true),
      makeRelease('v0.7.0-beta.2', true),
    );

    const result = await checkForUpdates('beta');

    expect(result.latestTag).toBe('v0.7.0-beta.2');
  });

  it('stable release ranks above its own pre-releases', async () => {
    mockReleases(
      makeRelease('v0.7.0-beta.3', true),
      makeRelease('v0.7.0'),
    );

    const result = await checkForUpdates('beta');

    expect(result.latestTag).toBe('v0.7.0');
  });

  it('defaults to stable channel when not specified', async () => {
    mockReleases(makeRelease('v0.7.0-beta.1', true));

    const result = await checkForUpdates();

    expect(result.updateAvailable).toBe(false);
  });

  it('returns a visible error for GitHub API failures', async () => {
    fetchMock.mockResolvedValue(failedResponse);

    const result = await checkForUpdates();

    expect(result.updateAvailable).toBe(false);
    expect(result.error).toBe('GitHub Releases returned HTTP 503.');
  });

  it('returns a visible error for network failures', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    const result = await checkForUpdates();

    expect(result.updateAvailable).toBe(false);
    expect(result.error).toBe('Could not reach GitHub Releases: network down');
  });
});
