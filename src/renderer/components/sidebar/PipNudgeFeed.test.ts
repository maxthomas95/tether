// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuotaInfo, VaultStatus } from '../../../shared/types';
import type { PipNudge } from '../../lib/pip-nudges';

const sources = vi.hoisted(() => ({
  quota: null as QuotaInfo | null,
  usage: null as { daily: unknown[] } | null,
  thresholds: { dailyUsd: null as number | null, weeklyUsd: null as number | null },
}));
vi.mock('../../hooks/useQuota', () => ({ useQuota: () => ({ quota: sources.quota, refresh: () => {}, enabled: true }) }));
vi.mock('../../hooks/useUsage', () => ({
  useUsage: () => ({ usage: sources.usage, enabled: true, cliToolBreakdownEnabled: false, budgetThresholds: sources.thresholds }),
}));

import { PipNudgeFeed } from './PipNudgeFeed';

const NOW = Date.parse('2026-11-12T12:00:00Z');
let container: HTMLDivElement;
let root: Root;
let vaultListener: ((status: VaultStatus) => void) | null;
let vaultStatus: () => Promise<VaultStatus>;
const unsubscribe = vi.fn();
const onChange = vi.fn<(nudges: readonly PipNudge[]) => void>();
const latest = () => onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] ?? [];

async function render(updateVersion: string | null = null) {
  await act(async () => root.render(createElement(PipNudgeFeed, { updateVersion, onChange })));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  sources.quota = null;
  sources.usage = null;
  sources.thresholds = { dailyUsd: null, weeklyUsd: null };
  vaultListener = null;
  vaultStatus = () => Promise.resolve({ enabled: false, loggedIn: false });
  vi.stubGlobal('electronAPI', {
    vault: {
      status: () => vaultStatus(),
      onStatusChange: (listener: (status: VaultStatus) => void) => { vaultListener = listener; return unsubscribe; },
    },
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  expect(vi.getTimerCount()).toBe(0);
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Pip nudge feed', () => {
  it('renders nothing and reports no nudges when all is well', async () => {
    await render();
    expect(container.innerHTML).toBe('');
    expect(latest()).toEqual([]);
  });

  it('reports an update and does not repeat an unchanged list', async () => {
    await render('0.8.0');
    expect(latest()).toEqual([{ key: 'update:0.8.0', kind: 'updateAvailable', detail: 'v0.8.0' }]);
    const calls = onChange.mock.calls.length;
    await render('0.8.0');
    expect(onChange).toHaveBeenCalledTimes(calls);
  });

  it('notices Vault expiry as the clock reaches the warning window', async () => {
    const expiresAt = new Date(NOW + 31 * 60_000).toISOString();
    vaultStatus = () => Promise.resolve({ enabled: true, loggedIn: true, expiresAt });
    await render();
    expect(latest()).toEqual([]);
    await act(async () => vi.advanceTimersByTime(2 * 60_000));
    expect(latest()).toEqual([{ key: `vault:${expiresAt}`, kind: 'vaultExpiring', detail: '29 minutes' }]);
    await act(async () => vaultListener?.({ enabled: true, loggedIn: false }));
    expect(latest()).toEqual([]);
  });

  it('treats a failed Vault read as no Vault', async () => {
    vaultStatus = () => Promise.reject(new Error('offline'));
    await render();
    expect(latest()).toEqual([]);
  });

  it('reports quota and budget from the hooks the footers use', async () => {
    sources.quota = {
      fiveHour: { utilization: 93, resetsAt: null }, sevenDay: { utilization: 5, resetsAt: null },
      scoped: [], subscriptionType: null, rateLimitTier: null, lastUpdated: null, error: null, codex: null,
    };
    sources.usage = { daily: [] };
    await render();
    expect(latest().map(nudge => nudge.kind)).toEqual(['quotaHigh']);
  });

  it('clears its nudges and stops listening when it unmounts', async () => {
    await render('0.8.0');
    await act(async () => root.render(null));
    expect(latest()).toEqual([]);
    expect(unsubscribe).toHaveBeenCalled();
  });
});
