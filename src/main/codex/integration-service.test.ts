import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { consumeCodexResetCredit, inspectCodexConfiguration, readCodexAccount, readCodexQuota, resetCreditsFromResponse } from './integration-service';
import { callCodexAppServer } from './app-server-client';

vi.mock('electron', () => ({
  app: {
    getPath: () => os.tmpdir(),
  },
}));

vi.mock('./app-server-client', () => ({
  callCodexAppServer: vi.fn(),
}));

const mockedCall = vi.mocked(callCodexAppServer);

describe('codex integration service', () => {
  beforeEach(() => {
    mockedCall.mockReset();
    delete process.env.CODEX_HOME;
  });

  it('projects account data without returning identity or token fields', async () => {
    mockedCall.mockResolvedValue([
      {
        method: 'account/read',
        ok: true,
        result: {
          account: {
            type: 'chatgpt',
            email: 'sentinel@example.com',
            accessToken: 'SECRET_SENTINEL',
            planType: 'pro',
          },
          requiresOpenaiAuth: false,
        },
      },
      {
        method: 'account/usage/read',
        ok: true,
        result: {
          summary: {
            lifetimeTokens: 100,
            peakDailyTokens: 40,
            longestRunningTurnSec: 90,
            currentStreakDays: 2,
            longestStreakDays: 3,
            impossible: 9007199254740993,
          },
          dailyUsageBuckets: [
            { startDate: '2026-09-07', tokens: 20 },
            { startDate: '2026-09-06', tokens: 3 },
            { startDate: '2026-09-07', tokens: 5 },
            { startDate: '2026-09-08', tokens: -1 },
            { startDate: 'not-a-date', tokens: 10 },
          ],
        },
      },
      {
        method: 'account/rateLimits/read',
        ok: true,
        result: {
          accountId: 'SECRET_ACCOUNT',
          rateLimits: {
            limitId: 'codex',
            limitName: 'Codex',
            planType: 'pro',
            primary: { usedPercent: 50.5, windowDurationMins: 300, resetsAt: 1799270400 },
            secondary: { usedPercent: 101, windowDurationMins: -1, resetsAt: 999999999999999999 },
          },
        },
      },
    ]);

    const snapshot = await readCodexAccount();

    expect(JSON.stringify(snapshot)).not.toContain('sentinel@example.com');
    expect(JSON.stringify(snapshot)).not.toContain('SECRET_SENTINEL');
    expect(JSON.stringify(snapshot)).not.toContain('SECRET_ACCOUNT');
    expect(snapshot.status).toBe('ready');
    expect(snapshot.authMode).toBe('chatgpt');
    expect(snapshot.planType).toBe('pro');
    expect(snapshot.summary?.lifetimeTokens).toBe(100);
    expect(snapshot.dailyUsage).toEqual([
      { date: '2026-09-06', tokens: 3 },
      { date: '2026-09-07', tokens: 25 },
    ]);
    expect(snapshot.rateLimits[0].primary).toEqual({
      usedPercent: 50.5,
      windowMinutes: 300,
      resetsAt: '2027-01-06T21:20:00.000Z',
    });
    expect(snapshot.rateLimits[0].secondary).toEqual({
      usedPercent: null,
      windowMinutes: null,
      resetsAt: null,
    });
    expect(mockedCall).toHaveBeenCalledWith([
      { method: 'account/read', params: { refreshToken: false } },
      { method: 'account/usage/read' },
      { method: 'account/rateLimits/read' },
    ]);
  });

  it('returns ready snapshots with warnings when old CLIs lack one method', async () => {
    mockedCall.mockResolvedValue([
      { method: 'account/read', ok: true, result: { account: { type: 'apiKey' }, requiresOpenaiAuth: false } },
      { method: 'account/usage/read', ok: false, error: 'Codex app-server method unavailable', unavailable: true },
      { method: 'account/rateLimits/read', ok: false, error: 'Codex app-server method unavailable', unavailable: true },
    ]);

    const snapshot = await readCodexAccount();

    expect(snapshot.status).toBe('ready');
    expect(snapshot.authMode).toBe('apiKey');
    expect(snapshot.warnings).toEqual([
      'account/usage/read: Codex app-server method unavailable',
      'account/rateLimits/read: Codex app-server method unavailable',
    ]);
  });

  it('reads lightweight quota without usage, config, or model calls', async () => {
    mockedCall.mockResolvedValue([
      { method: 'account/read', ok: true, result: { account: { type: 'chatgpt', planType: 'plus' }, requiresOpenaiAuth: false } },
      {
        method: 'account/rateLimits/read',
        ok: true,
        result: {
          rateLimitsByLimitId: {
            codex: {
              limitId: 'codex',
              limitName: 'Codex',
              primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: null },
            },
          },
          rateLimits: {},
        },
      },
    ]);

    const snapshot = await readCodexQuota();

    expect(snapshot.status).toBe('ready');
    expect(snapshot.summary).toBeNull();
    expect(snapshot.dailyUsage).toEqual([]);
    expect(snapshot.rateLimits[0].primary?.usedPercent).toBe(20);
    expect(mockedCall).toHaveBeenCalledWith([
      { method: 'account/read', params: { refreshToken: false } },
      { method: 'account/rateLimits/read' },
    ]);
  });

  it('reports the free reset count and the soonest expiry of available credits', async () => {
    mockedCall.mockResolvedValue([
      { method: 'account/read', ok: true, result: { account: { type: 'chatgpt', planType: 'plus' } } },
      {
        method: 'account/rateLimits/read',
        ok: true,
        result: {
          rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: null } },
          rateLimitResetCredits: {
            availableCount: 2,
            credits: [
              { id: 'later', status: 'available', grantedAt: 1_793_572_663, expiresAt: 1_796_164_663 },
              { id: 'sooner', status: 'available', grantedAt: 1_793_477_086, expiresAt: 1_796_069_086 },
              { id: 'spent', status: 'redeemed', grantedAt: 1_790_000_000, expiresAt: 1_790_100_000 },
            ],
          },
        },
      },
    ]);

    const snapshot = await readCodexQuota();

    expect(snapshot.resetCredits).toEqual({
      availableCount: 2,
      soonestExpiresAt: new Date(1_796_069_086 * 1000).toISOString(),
    });
  });

  it('returns error for quota when rate limits fail even if account succeeds', async () => {
    mockedCall.mockResolvedValue([
      { method: 'account/read', ok: true, result: { account: { type: 'chatgpt', planType: 'plus' }, requiresOpenaiAuth: false } },
      { method: 'account/rateLimits/read', ok: false, error: 'Codex app-server request failed' },
    ]);

    const snapshot = await readCodexQuota();

    expect(snapshot.status).toBe('error');
    expect(snapshot.lastUpdated).toBeNull();
    expect(snapshot.error).toBe('Codex quota could not be read');
    expect(snapshot.rateLimits).toEqual([]);
  });

  it('does not stamp unavailable account snapshots as successful observations', async () => {
    mockedCall.mockResolvedValue([
      { method: 'account/read', ok: false, error: 'Codex app-server unavailable', unavailable: true },
      { method: 'account/usage/read', ok: false, error: 'Codex app-server unavailable', unavailable: true },
      { method: 'account/rateLimits/read', ok: false, error: 'Codex app-server unavailable', unavailable: true },
    ]);

    const snapshot = await readCodexAccount();

    expect(snapshot.status).toBe('unavailable');
    expect(snapshot.lastUpdated).toBeNull();
    expect(snapshot.summary).toBeNull();
  });

  it('sanitizes configuration values and lists profile filenames only', async () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-codex-home-'));
    process.env.CODEX_HOME = codexHome;
    fs.writeFileSync(path.join(codexHome, 'alpha.config.toml'), 'model = "x"');
    fs.writeFileSync(path.join(codexHome, 'config.toml'), 'secret = "SECRET"');

    mockedCall.mockResolvedValue([
      {
        method: 'config/read',
        ok: true,
        result: {
          config: {
            model: 'gpt-5-codex',
            model_reasoning_effort: 'high',
            sandbox_mode: 'workspace-write',
            approval_policy: { granular: { rules: true, sandbox_approval: true, mcp_elicitations: true, token: 'SECRET' } },
            web_search: 'live',
            service_tier: null,
            mcp_servers: {
              github: { command: 'SECRET_COMMAND', env: { TOKEN: 'SECRET' }, enabled: true },
              ['x'.repeat(200)]: { enabled: true },
            },
          },
          origins: {
            model: { name: { type: 'user', file: path.join(codexHome, 'config.toml') }, version: '1' },
            approval_policy: { name: { type: 'project', dotCodexFolder: path.join(codexHome, '.codex') }, version: '1' },
            service_tier: { name: { type: 'untrustedSource', value: 'SECRET' }, version: '1' },
          },
        },
      },
      {
        method: 'model/list',
        ok: true,
        result: {
          data: [{
            id: 'display-id',
            displayName: 'GPT-5 Codex',
            model: 'gpt-5-codex',
            supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Medium' }],
            defaultReasoningEffort: 'medium',
          }],
        },
      },
    ]);

    const snapshot = await inspectCodexConfiguration('C:\\repo\\tether');

    expect(JSON.stringify(snapshot)).not.toContain('SECRET');
    expect(snapshot.fields).toContainEqual({ key: 'approval_policy', value: 'Custom policy', source: 'project' });
    expect(snapshot.fields).toContainEqual({ key: 'model', value: 'gpt-5-codex', source: 'user' });
    expect(snapshot.fields).toContainEqual({ key: 'service_tier', value: null, source: null });
    expect(snapshot.profiles).toEqual([{ name: 'alpha' }]);
    expect(snapshot.integrations).toEqual([
      { name: 'github', kind: 'mcp', enabled: true },
      { name: 'x'.repeat(160), kind: 'mcp', enabled: true },
    ]);
    expect(snapshot.models).toEqual([{
      id: 'gpt-5-codex',
      displayName: 'GPT-5 Codex',
      reasoningEfforts: ['medium'],
      defaultReasoningEffort: 'medium',
    }]);
    expect(mockedCall).toHaveBeenCalledWith([
      { method: 'config/read', params: { includeLayers: true, cwd: 'C:\\repo\\tether' } },
      { method: 'model/list', params: { includeHidden: false, limit: 100, cursor: null } },
    ]);
  });

  it('returns partial configuration status without default fields when config is null', async () => {
    mockedCall.mockResolvedValue([
      { method: 'config/read', ok: true, result: null },
      { method: 'model/list', ok: true, result: { data: [{ id: 'gpt-5-codex' }] } },
    ]);

    const snapshot = await inspectCodexConfiguration();

    expect(snapshot.status).toBe('ready');
    expect(snapshot.error).toBe('config/read: Codex app-server sent an invalid response');
    expect(snapshot.fields).toEqual([]);
    expect(snapshot.integrations).toEqual([]);
    expect(snapshot.models).toEqual([{
      id: 'gpt-5-codex',
      displayName: 'gpt-5-codex',
      reasoningEfforts: [],
      defaultReasoningEffort: null,
    }]);
  });

  it('returns partial configuration status when config read fails but model list succeeds', async () => {
    mockedCall.mockResolvedValue([
      { method: 'config/read', ok: false, error: 'Codex app-server request failed' },
      { method: 'model/list', ok: true, result: { data: [] } },
    ]);

    const snapshot = await inspectCodexConfiguration();

    expect(snapshot.status).toBe('ready');
    expect(snapshot.error).toBe('config/read: Codex app-server request failed');
    expect(snapshot.fields).toEqual([]);
    expect(snapshot.integrations).toEqual([]);
  });
});

describe('Codex reset credits', () => {
  beforeEach(() => {
    mockedCall.mockReset();
  });

  it('keeps the count when only the summary is reported and rejects malformed counts', () => {
    expect(resetCreditsFromResponse({ rateLimitResetCredits: { availableCount: 1, credits: null } }))
      .toEqual({ availableCount: 1, soonestExpiresAt: null });
    expect(resetCreditsFromResponse({ rateLimitResetCredits: { availableCount: -1 } })).toBeNull();
    expect(resetCreditsFromResponse({ rateLimitResetCredits: null })).toBeNull();
    expect(resetCreditsFromResponse(null)).toBeNull();
  });

  it('redeems with a fresh idempotency key and a longer timeout', async () => {
    mockedCall.mockResolvedValue([{ method: 'account/rateLimitResetCredit/consume', ok: true, result: { outcome: 'reset' } }]);

    expect(await consumeCodexResetCredit()).toEqual({ outcome: 'reset' });
    await consumeCodexResetCredit();

    const [[firstCalls, options], [secondCalls]] = mockedCall.mock.calls;
    const firstKey = (firstCalls[0].params as { idempotencyKey: string }).idempotencyKey;
    const secondKey = (secondCalls[0].params as { idempotencyKey: string }).idempotencyKey;
    expect(firstCalls[0].method).toBe('account/rateLimitResetCredit/consume');
    expect(firstKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(secondKey).not.toBe(firstKey);
    expect(options).toEqual({ timeoutMs: 30_000 });
  });

  it.each(['nothingToReset', 'noCredit', 'alreadyRedeemed'])('passes through the %s outcome', async outcome => {
    mockedCall.mockResolvedValue([{ method: 'account/rateLimitResetCredit/consume', ok: true, result: { outcome } }]);
    expect(await consumeCodexResetCredit()).toEqual({ outcome });
  });

  it('treats an unknown method as unsupported but timeouts and odd replies as unknown', async () => {
    mockedCall.mockResolvedValueOnce([{ method: 'account/rateLimitResetCredit/consume', ok: false, error: 'Codex app-server method unavailable', unavailable: true }]);
    expect(await consumeCodexResetCredit()).toEqual({ outcome: 'unsupported' });

    mockedCall.mockResolvedValueOnce([{ method: 'account/rateLimitResetCredit/consume', ok: false, error: 'Codex app-server unavailable', unavailable: true }]);
    expect(await consumeCodexResetCredit()).toEqual({ outcome: 'unknown' });

    mockedCall.mockResolvedValueOnce([{ method: 'account/rateLimitResetCredit/consume', ok: true, result: { outcome: 'surprise' } }]);
    expect(await consumeCodexResetCredit()).toEqual({ outcome: 'unknown' });
  });
});
