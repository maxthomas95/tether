// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { QuotaFooter } from './QuotaFooter';
import type { QuotaInfo } from '../../../shared/types';

function quota(usedPercent: number, availableCount = 2): QuotaInfo {
  return {
    fiveHour: { utilization: null, resetsAt: null },
    sevenDay: { utilization: null, resetsAt: null },
    subscriptionType: null,
    rateLimitTier: null,
    lastUpdated: null,
    error: null,
    codex: {
      primary: { usedPercent, resetAt: null },
      secondary: { usedPercent: null, resetAt: null },
      planType: 'plus',
      error: null,
      lastUpdated: '2026-11-10T12:00:00.000Z',
      buckets: [{ id: 'codex', name: 'Codex', primary: { usedPercent, windowMinutes: 300, resetsAt: null }, secondary: null }],
      resetCredits: { availableCount, soonestExpiresAt: '2026-11-30T20:04:46.000Z' },
    },
  };
}

async function renderFooter(info: QuotaInfo, props: Parameters<typeof QuotaFooter>[0] = {}) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const refresh = vi.fn();
  const redeemCodexReset = vi.fn().mockResolvedValue({ outcome: 'reset' });
  vi.stubGlobal('electronAPI', {
    config: { get: vi.fn().mockResolvedValue(''), set: vi.fn() },
    quota: { get: vi.fn().mockResolvedValue(info), refresh, onUpdate: () => () => {}, redeemCodexReset },
  });
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(QuotaFooter, props)));
  const button = () => container.querySelector<HTMLButtonElement>('.quota-reset-btn');
  return { container, root, refresh, redeemCodexReset, button };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it('shows the free reset count and soonest expiry, without a button when no confirm is wired', async () => {
  const { container, root, button } = await renderFooter(quota(95));
  try {
    expect(container.querySelector('.quota-reset-credits-text')?.textContent).toMatch(/^2 free resets · expires /);
    expect(button()).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

it('hides the reset line when no resets are available', async () => {
  const { container, root } = await renderFooter(quota(95, 0), { confirm: vi.fn() });
  try {
    expect(container.querySelector('.quota-reset-credits')).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

it('does not redeem or refresh when the confirmation is cancelled', async () => {
  const confirm = vi.fn().mockResolvedValue({ confirmed: false });
  const onCodexReset = vi.fn();
  const { root, refresh, redeemCodexReset, button } = await renderFooter(quota(95), { confirm, onCodexReset });
  try {
    await act(async () => button()!.click());
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0][0].message).not.toContain('wasting');
    expect(redeemCodexReset).not.toHaveBeenCalled();
    expect(onCodexReset).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});

it('warns about low usage, then redeems once confirmed and reports the outcome', async () => {
  const confirm = vi.fn().mockResolvedValue({ confirmed: true });
  const onCodexReset = vi.fn();
  const { root, redeemCodexReset, button } = await renderFooter(quota(30), { confirm, onCodexReset });
  try {
    await act(async () => button()!.click());
    expect(confirm.mock.calls[0][0]).toMatchObject({ title: 'Use a Codex reset?', danger: true });
    expect(confirm.mock.calls[0][0].message).toContain('only 30% used');
    expect(redeemCodexReset).toHaveBeenCalledOnce();
    expect(onCodexReset).toHaveBeenCalledWith('reset');
  } finally {
    await act(async () => root.unmount());
  }
});

it('reports an unknown outcome when the redemption request throws', async () => {
  const confirm = vi.fn().mockResolvedValue({ confirmed: true });
  const onCodexReset = vi.fn();
  const { root, redeemCodexReset, button } = await renderFooter(quota(95), { confirm, onCodexReset });
  redeemCodexReset.mockRejectedValue(new Error('ipc closed'));
  try {
    await act(async () => button()!.click());
    expect(onCodexReset).toHaveBeenCalledWith('unknown');
    expect(button()!.disabled).toBe(false);
  } finally {
    await act(async () => root.unmount());
  }
});
