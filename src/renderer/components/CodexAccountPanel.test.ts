// @vitest-environment jsdom
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexAccountPanel } from './CodexAccountPanel';
import { button, change, click, createView, deferred } from './visibility.test-helper';
import type { CodexAccountSnapshot, CodexConfigurationSnapshot } from '../../shared/codex-types';
import type { SessionInfo } from '../../shared/types';

const accountSnapshot: CodexAccountSnapshot = {
  status: 'ready', lastUpdated: '2026-09-08T12:00:00Z', error: null, authMode: 'chatgpt', planType: 'pro',
  summary: { lifetimeTokens: 1000, peakDailyTokens: 700, longestRunningTurnSec: 90, currentStreakDays: 2, longestStreakDays: 5 },
  dailyUsage: [{ date: '2026-09-07', tokens: 300 }, { date: '2026-09-08', tokens: 700 }],
  rateLimits: [{ id: 'codex', name: 'Codex', primary: { usedPercent: 25, windowMinutes: 300, resetsAt: '2026-09-08T17:00:00Z' },
    secondary: { usedPercent: null, windowMinutes: null, resetsAt: null } }], warnings: ['Usage excludes local estimates'],
};
const configSnapshot: CodexConfigurationSnapshot = {
  status: 'ready', lastUpdated: '2026-09-08T12:00:00Z', error: null,
  fields: [{ key: 'model', value: 'gpt-5', source: 'user' }, { key: 'profile', value: null, source: null }],
  profiles: [{ name: 'work' }], models: [],
  integrations: [{ kind: 'mcp', name: 'docs', enabled: true }, { kind: 'skill', name: 'review', enabled: false }, { kind: 'skill', name: 'unknown', enabled: null }],
};
const sessions = [{ id: 'one', label: 'Project One', cliTool: 'codex' }, { id: 'two', label: 'Project Two', cliTool: 'codex' },
  { id: 'claude', label: 'Claude project', cliTool: 'claude' }] as SessionInfo[];
let view: ReturnType<typeof createView>;
let account: ReturnType<typeof vi.fn>;
let configuration: ReturnType<typeof vi.fn>;
let loaded: ReturnType<typeof vi.fn>;
beforeEach(() => {
  view = createView();
  account = vi.fn().mockResolvedValue(accountSnapshot);
  configuration = vi.fn().mockResolvedValue(configSnapshot);
  loaded = vi.fn();
  window.electronAPI = { codex: { account, configuration } } as unknown as typeof window.electronAPI;
});
afterEach(async () => view.dispose());
const render = (current = sessions) => view.render(React.createElement(CodexAccountPanel, { sessions: current, onConfigurationLoaded: loaded }));

describe('Codex account and configuration inspection', () => {
  it('loads only on request and preserves the last account reading when refresh fails', async () => {
    await render();
    expect(account).not.toHaveBeenCalled();
    expect(configuration).not.toHaveBeenCalled();
    const pending = deferred<CodexAccountSnapshot>();
    account.mockReturnValueOnce(pending.promise);
    await click(button(view.container, 'Load account usage'));
    expect(button(view.container, 'Loading...').disabled).toBe(true);
    await act(async () => pending.resolve(accountSnapshot));
    expect(view.container.textContent).toContain('Status: Ready');
    expect(view.container.textContent).toContain('1,000');
    expect(view.container.textContent).toContain('1m 30s');
    expect(view.container.textContent).toContain('25% used');
    expect(view.container.textContent).toContain('Usage excludes local estimates');
    expect(view.container.querySelector('[aria-label="Daily Codex account token trend"]')).not.toBeNull();
    account.mockRejectedValueOnce(new Error('Offline'));
    await click(button(view.container, 'Refresh'));
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe('Offline');
    expect(view.container.textContent).toContain('1,000');
    await click(button(view.container, 'Retry'));
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
  });

  it.each(['unavailable', 'error'] as const)('offers retry for %s account metadata', async status => {
    account.mockResolvedValue({ ...accountSnapshot, status, lastUpdated: null, authMode: null, planType: null, summary: null,
      dailyUsage: [], rateLimits: [{ id: 'missing', name: 'Missing', primary: null, secondary: null }], error: 'Metadata unavailable' });
    await render();
    await click(button(view.container, 'Load account usage'));
    expect(view.container.textContent).toContain(status === 'error' ? 'Status: Error' : 'Status: Unavailable');
    expect(view.container.textContent).toContain('Updated: Not loaded');
    expect(view.container.textContent).toContain('Metadata unavailable');
    expect(button(view.container, 'Retry').disabled).toBe(false);
    expect(view.container.querySelector('svg')).toBeNull();
  });

  it.each([30, 120])('formats %s-second turns and clamps reported quota percentages', async seconds => {
    account.mockResolvedValue({ ...accountSnapshot, lastUpdated: 'unknown time',
      summary: { ...accountSnapshot.summary, longestRunningTurnSec: seconds },
      dailyUsage: [{ date: '2026-09-08', tokens: 0 }], rateLimits: [{ id: 'limit', name: 'Limit',
        primary: { usedPercent: 125, windowMinutes: 60, resetsAt: 'unknown reset' },
        secondary: { usedPercent: -5, windowMinutes: 0, resetsAt: null } }] });
    await render();
    await click(button(view.container, 'Load account usage'));
    expect(view.container.textContent).toContain(seconds === 30 ? '30s' : '2m');
    expect(view.container.textContent).toContain('100% used');
    expect(view.container.textContent).toContain('0% used');
    expect(view.container.textContent).toContain('unknown reset');
    expect(view.container.textContent).toContain('Updated: unknown time');
  });

  it('renders sanitized configuration and inspects the selected Codex project', async () => {
    await render();
    const select = view.container.querySelector('select')!;
    expect([...select.options].map(option => option.text)).not.toContain('Claude project');
    await click(button(view.container, 'Inspect configuration'));
    expect(configuration).toHaveBeenLastCalledWith(undefined);
    expect(loaded).toHaveBeenLastCalledWith(configSnapshot);
    expect(view.container.querySelector('[role="table"]')?.textContent).toContain('modelgpt-5user');
    expect(view.container.textContent).toContain('docs (mcp, enabled)');
    expect(view.container.textContent).toContain('review (skill, disabled)');
    expect(view.container.textContent).toContain('unknown (skill)');
    await change(select, 'one');
    expect(loaded).toHaveBeenLastCalledWith(null);
    expect(view.container.querySelector('[role="table"]')).toBeNull();
    await click(button(view.container, 'Inspect configuration'));
    expect(configuration).toHaveBeenLastCalledWith('one');
    configuration.mockRejectedValueOnce('Cannot inspect');
    await click(button(view.container, 'Refresh configuration'));
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe('Cannot inspect');
    expect(view.container.querySelector('[role="table"]')).not.toBeNull();
  });

  it('ignores an in-flight configuration response after switching or removing its project', async () => {
    const pending = deferred<CodexConfigurationSnapshot>();
    configuration.mockReturnValueOnce(pending.promise);
    await render();
    await change(view.container.querySelector('select')!, 'one');
    await click(button(view.container, 'Inspect configuration'));
    expect(button(view.container, 'Inspecting...').disabled).toBe(true);
    await change(view.container.querySelector('select')!, 'two');
    await act(async () => pending.resolve(configSnapshot));
    expect(loaded).not.toHaveBeenCalledWith(configSnapshot);
    await click(button(view.container, 'Inspect configuration'));
    await render([]);
    expect(view.container.querySelector('select')!.value).toBe('');
    expect(view.container.querySelector('[role="table"]')).toBeNull();
    expect(loaded).toHaveBeenLastCalledWith(null);
  });

  it('ignores late account and configuration completions after unmount', async () => {
    const pendingAccount = deferred<CodexAccountSnapshot>();
    const pendingConfig = deferred<CodexConfigurationSnapshot>();
    account.mockReturnValueOnce(pendingAccount.promise);
    configuration.mockReturnValueOnce(pendingConfig.promise);
    await render();
    await click(button(view.container, 'Load account usage'));
    await click(button(view.container, 'Inspect configuration'));
    await view.render(null);
    await act(async () => { pendingAccount.reject('Offline'); pendingConfig.resolve(configSnapshot); });
    expect(loaded).not.toHaveBeenCalled();
    expect(view.container.textContent).toBe('');
  });

  it('shows initial request errors and unavailable empty configuration without inventing values', async () => {
    account.mockRejectedValueOnce('No account');
    configuration.mockRejectedValueOnce(new Error('No configuration'));
    await render();
    await click(button(view.container, 'Load account usage'));
    await click(button(view.container, 'Inspect configuration'));
    expect([...view.container.querySelectorAll('[role="alert"]')].map(node => node.textContent)).toEqual(['No account', 'No configuration']);
    configuration.mockResolvedValue({ ...configSnapshot, status: 'unavailable', error: 'Unsupported', fields: [], profiles: [], integrations: [] });
    await click(view.container.querySelectorAll<HTMLButtonElement>('button')[1]);
    expect(view.container.textContent).toContain('Unsupported');
    expect(view.container.textContent).toContain('Status: unavailable');
  });
});
