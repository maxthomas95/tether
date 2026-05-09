import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.4.1',
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

describe('checkForUpdates', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('reports update availability from GitHub releases', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [
        { tag_name: 'v0.4.2', html_url: 'https://github.com/maxthomas95/tether/releases/tag/v0.4.2', draft: false, prerelease: false },
      ],
    } as unknown as Response);

    const result = await checkForUpdates();

    expect(result.updateAvailable).toBe(true);
    expect(result.latestVersion).toBe('0.4.2');
    expect(result.error).toBeUndefined();
  });

  it('returns a visible error for GitHub API failures', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 } as unknown as Response);

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
