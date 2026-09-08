// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PaneStatusStrip } from './PaneStatusStrip';
import type { SessionInfo, SessionUsage, UsageInfo } from '../../shared/types';

const usage: SessionUsage = { sessionId: 'remote:source', cliTool: 'codex', inputTokens: 10, outputTokens: 5,
  cacheCreationTokens: 0, cacheReadTokens: 0, totalCost: 0.25, messageCount: 1,
  firstMessageAt: null, lastMessageAt: null, parsedByteOffset: 100,
  models: [{ model: 'gpt-5', inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0.25 }] };
let root: Root;
let container: HTMLDivElement;
let getSession: ReturnType<typeof vi.fn>;
let listeners: Set<(info: UsageInfo) => void>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  getSession = vi.fn(async () => null);
  listeners = new Set();
  window.electronAPI = { config: { get: async () => 'true' }, usage: { getSession,
    onUpdate: (callback: (info: UsageInfo) => void) => { listeners.add(callback); return () => listeners.delete(callback); },
  } } as unknown as typeof window.electronAPI;
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe('remote usage pane smoke', () => {
  it('shows pending and unavailable states without a measured zero', async () => {
    await act(async () => root.render(React.createElement(PaneStatusStrip, { sessionId: 'pending', remoteStatus: 'pending' })));
    expect(container.textContent).toBe('Waiting for remote usage');
    await act(async () => root.render(React.createElement(PaneStatusStrip, { sessionId: 'pending', remoteStatus: 'unavailable' })));
    expect(container.textContent).toBe('Usage unavailable');
  });

  it('retains measured totals and labels them stale during connection failures', async () => {
    getSession.mockResolvedValue(usage);
    await act(async () => root.render(React.createElement(PaneStatusStrip, { sessionId: usage.sessionId, remoteStatus: 'unavailable' })));
    expect(container.textContent).toContain('Last collected');
    expect(container.textContent).toContain('$0.25');
    expect(container.firstElementChild?.getAttribute('title')).toContain('Retrying automatically');
  });

  it('shows the native conversation identity and stale coverage in remote session details', async () => {
    getSession.mockResolvedValue(usage);
    const session = { id: 'pane', cliTool: 'codex', toolSessionId: 'native-id', usageSessionId: usage.sessionId, remoteUsageStatus: 'unavailable', workingDir: '/work' } as SessionInfo;
    await act(async () => root.render(React.createElement(PaneStatusStrip, { sessionId: usage.sessionId, session, remoteStatus: 'unavailable' })));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Show session details"]')!.click());
    const rows = [...document.querySelectorAll('.session-inspector-row')];
    const value = (label: string) => rows.find(row => row.querySelector('dt')?.textContent === label)?.querySelector('dd')?.textContent;
    expect(value('Native ID')).toBe('native-id');
    expect(value('Usage Tracking')).toBe('Last collected remote totals; retrying');
  });

  it('ignores an old pending-id response after remote discovery and a stale snapshot after a live update', async () => {
    let finishOld!: (value: SessionUsage | null) => void;
    let finishNew!: (value: SessionUsage | null) => void;
    getSession.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { finishNew = resolve; }));
    await act(async () => root.render(React.createElement(PaneStatusStrip, { sessionId: 'pending', remoteStatus: 'pending' })));
    await act(async () => root.render(React.createElement(PaneStatusStrip, { sessionId: usage.sessionId, remoteStatus: 'collecting' })));
    await act(async () => {
      for (const callback of listeners) callback({ sessions: { [usage.sessionId]: usage }, daily: [], totalCost: 0.25, lastUpdated: '' });
      finishOld(null);
      finishNew(null);
    });
    expect(container.textContent).toContain('$0.25');
    expect(listeners.size).toBe(1);
  });
});
