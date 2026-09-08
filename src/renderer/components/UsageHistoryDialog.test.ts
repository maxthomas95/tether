// @vitest-environment jsdom
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UsageHistoryDialog } from './UsageHistoryDialog';
import { button, change, click, createView, deferred } from './visibility.test-helper';
import type { SessionUsage, UsageInfo } from '../../shared/types';

function session(sessionId: string, overrides: Partial<SessionUsage> = {}): SessionUsage {
  const model = { model: 'gpt-5', inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheCreationTokens: 0, reasoningTokens: 10, cost: 2 };
  return { sessionId, cliTool: 'codex', environmentId: 'local', workingDir: '/alpha',
    ...model, totalCost: 2, models: [model], messageCount: 1,
    firstMessageAt: '2026-09-08T10:00:00Z', lastMessageAt: '2026-09-08T10:00:00Z', parsedByteOffset: 10,
    currentModel: 'gpt-5', currentReasoningEffort: 'high', contextUsedTokens: 150, contextWindowTokens: 10000,
    dayTiming: 'event', daily: [{ date: '2026-09-08', ...model, totalCost: 2, messageCount: 1, models: [model] }], ...overrides };
}
const alpha = session('alpha');
const beta = session('beta', { cliTool: 'claude', environmentId: 'remote', workingDir: '/beta', daily: undefined,
  totalCost: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, models: [], messageCount: null, dayTiming: 'unknown',
  firstMessageAt: null, lastMessageAt: null, currentModel: undefined, currentReasoningEffort: undefined,
  contextUsedTokens: undefined, contextWindowTokens: undefined });
const snapshot: UsageInfo = { sessions: { alpha, beta }, daily: [], totalCost: 3, lastUpdated: null };
let view: ReturnType<typeof createView>;
let getAll: ReturnType<typeof vi.fn>;
let listSessions: ReturnType<typeof vi.fn>;
let listEnvironments: ReturnType<typeof vi.fn>;
let listeners: Set<(info: UsageInfo) => void>;
let close: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-08T12:00:00Z'));
  view = createView();
  close = vi.fn();
  listeners = new Set();
  getAll = vi.fn().mockResolvedValue(snapshot);
  listSessions = vi.fn().mockResolvedValue([{ id: 'alpha', label: 'Alpha' }, { id: 'beta', label: 'Beta' }]);
  listEnvironments = vi.fn().mockResolvedValue([{ id: 'local', name: 'Local' }, { id: 'remote', name: 'Remote' }]);
  window.electronAPI = { usage: { getAll, onUpdate: (fn: (info: UsageInfo) => void) => { listeners.add(fn); return () => listeners.delete(fn); } },
    session: { list: listSessions }, environment: { list: listEnvironments } } as unknown as typeof window.electronAPI;
});
afterEach(async () => { await view.dispose(); vi.useRealTimers(); });
const render = (isOpen = true) => view.render(React.createElement(UsageHistoryDialog, { isOpen, onClose: close }));
const rows = () => [...view.container.querySelectorAll<HTMLTableRowElement>('.usage-explorer-ledger__row')];

describe('usage history interactions', () => {
  it('loads only while open, shows unknown-date coverage and expands the per-model ledger', async () => {
    await render(false);
    expect(getAll).not.toHaveBeenCalled();
    await render();
    expect(rows()).toHaveLength(1);
    await click(button(view.container, 'All time'));
    expect(rows()).toHaveLength(2);
    expect(view.container.textContent).toContain('Usage with unknown dates is included');
    await click(rows().find(row => row.textContent?.includes('Alpha'))!);
    expect(view.container.querySelector('[aria-label="Model breakdown"]')?.textContent).toContain('gpt-5');
    expect(view.container.querySelector('[title="Latest observation: gpt-5, high"]')?.textContent).toBe('150 / 10.0k');
    await click(rows().find(row => row.textContent?.includes('Alpha'))!);
    expect(view.container.querySelector('[aria-label="Model breakdown"]')).toBeNull();
    await act(async () => rows().find(row => row.textContent?.includes('Beta'))!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(view.container.querySelector('.usage-explorer-ledger__detail')?.textContent).toContain('n/a');
    await render(false);
    expect(listeners.size).toBe(0);
    expect(view.container.textContent).toBe('');
  });

  it('filters each dimension, toggles filters off, and restores the default range', async () => {
    await render();
    await click(button(view.container, 'All time'));
    for (const [legend, option] of [['CLI', 'Codex CLI'], ['Project', '/alpha'], ['Environment', 'Local'], ['Model', 'gpt-5']]) {
      const group = [...view.container.querySelectorAll('fieldset')].find(field => field.querySelector('legend')?.textContent === legend)!;
      const checkbox = [...group.querySelectorAll('label')].find(label => label.textContent === option)!.querySelector('input')!;
      await click(checkbox);
      expect(rows()).toHaveLength(1);
      expect(rows()[0].textContent).toContain('Alpha');
      await click(checkbox);
      expect(rows()).toHaveLength(2);
    }
    await click(button(view.container, 'Reset filters'));
    expect(rows()).toHaveLength(1);
    expect(button(view.container, '30d').getAttribute('aria-pressed')).toBe('true');
  });

  it('sorts the ledger in both directions and selects a UTC chart day', async () => {
    await render();
    await click(button(view.container, 'All time'));
    await click(button(view.container, 'Session'));
    expect(rows()[0].textContent).toContain('Alpha');
    await click(button(view.container, 'Session'));
    expect(rows()[0].textContent).toContain('Beta');
    await click(button(view.container, 'Cost'));
    expect(rows()[0].textContent).toContain('Alpha');
    await click(button(view.container, 'Cost'));
    expect(rows()[0].textContent).toContain('Beta');
    await click(button(view.container, 'Tokens'));
    expect(rows()[0].textContent).toContain('Alpha');
    await click(button(view.container, 'Last'));
    expect(rows()[0].textContent).toContain('Alpha');
    await click(view.container.querySelector<HTMLButtonElement>('[aria-label="2026-09-08 UTC: $2.00"]')!);
    expect(view.container.querySelector<HTMLInputElement>('[aria-label="Custom start date"]')!.value).toBe('2026-09-08');
    expect(view.container.querySelector<HTMLInputElement>('[aria-label="Custom end date"]')!.value).toBe('2026-09-08');
    expect(rows()).toHaveLength(1);
  });

  it('validates custom ranges, caps long trends and displays empty results', async () => {
    await render();
    await click(button(view.container, 'Custom'));
    await change(view.container.querySelector<HTMLInputElement>('[aria-label="Custom start date"]')!, '');
    expect(view.container.textContent).toContain('Enter valid custom dates');
    await change(view.container.querySelector<HTMLInputElement>('[aria-label="Custom start date"]')!, '2020-01-01');
    await change(view.container.querySelector<HTMLInputElement>('[aria-label="Custom end date"]')!, '2022-01-01');
    expect(view.container.textContent).toContain('Custom trend capped to 366 UTC days');
    expect(view.container.textContent).toContain('No usage matches these filters');
    await click(button(view.container, 'Today'));
    expect(rows()).toHaveLength(1);
    await click(button(view.container, '30d'));
    expect(view.container.querySelectorAll('.usage-explorer-chart__bar')).toHaveLength(30);
  });

  it('keeps streamed data over a stale snapshot and ignores responses from a closed dialog', async () => {
    const pending = deferred<UsageInfo>();
    getAll.mockReturnValueOnce(pending.promise);
    await render();
    await act(async () => { for (const fn of listeners) fn(snapshot); });
    await act(async () => pending.resolve({ ...snapshot, sessions: {} }));
    expect(rows()).toHaveLength(1);
    const closed = deferred<UsageInfo>();
    getAll.mockReturnValueOnce(closed.promise);
    await render(false);
    await render();
    await render(false);
    await act(async () => closed.resolve(snapshot));
    expect(view.container.textContent).toBe('');
    expect(listeners.size).toBe(0);
  });

  it('survives failed loads and supports close button, Escape and backdrop dismissal', async () => {
    getAll.mockRejectedValueOnce(new Error('Offline'));
    listSessions.mockRejectedValueOnce(new Error('Offline'));
    listEnvironments.mockRejectedValueOnce(new Error('Offline'));
    await render();
    expect(view.container.textContent).toContain('No usage matches');
    await click(button(view.container, 'Close'));
    expect(close).toHaveBeenCalledTimes(1);
    await act(async () => view.container.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(close).toHaveBeenCalledTimes(2);
    await click(view.container.querySelector<HTMLElement>('.dialog-overlay')!);
    expect(close).toHaveBeenCalledTimes(3);
  });
});
