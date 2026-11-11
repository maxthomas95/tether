// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { QuotaFooter } from './QuotaFooter';
import type { QuotaInfo } from '../../../shared/types';

function quota(overrides: Partial<QuotaInfo> = {}): QuotaInfo {
  return {
    fiveHour: { utilization: 10, resetsAt: null },
    sevenDay: { utilization: 20, resetsAt: null },
    scoped: [],
    subscriptionType: 'max',
    rateLimitTier: null,
    lastUpdated: '2026-11-10T12:00:00.000Z',
    error: null,
    codex: null,
    ...overrides,
  };
}

async function renderFooter(info: QuotaInfo) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('electronAPI', {
    config: { get: vi.fn().mockResolvedValue(''), set: vi.fn() },
    quota: { get: vi.fn().mockResolvedValue(info), refresh: vi.fn(), onUpdate: () => () => {} },
  });
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(QuotaFooter)));
  return { container, root };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it('shows a model-scoped weekly limit under the overall Claude windows', async () => {
  const { container, root } = await renderFooter(quota({
    scoped: [{ label: 'Fable', utilization: 26, resetsAt: null }],
  }));
  try {
    const rows = [...container.querySelectorAll('.quota-row')].map(row => row.textContent);
    expect(container.textContent).toContain('Fable');
    expect(rows).toEqual(['5h90% left', '7d80% left', '7d74% left']);
  } finally {
    await act(async () => root.unmount());
  }
});

it('shows the Claude section from a scoped limit alone and skips unknown readings', async () => {
  const { container, root } = await renderFooter(quota({
    fiveHour: { utilization: null, resetsAt: null },
    sevenDay: { utilization: null, resetsAt: null },
    scoped: [
      { label: 'Fable', utilization: 40, resetsAt: null },
      { label: 'Opus', utilization: null, resetsAt: null },
    ],
  }));
  try {
    expect(container.textContent).toContain('Fable');
    expect(container.textContent).toContain('60% left');
    expect(container.textContent).not.toContain('Opus');
  } finally {
    await act(async () => root.unmount());
  }
});
