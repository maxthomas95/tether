// @vitest-environment jsdom
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChildAgentViewer } from './ChildAgentViewer';
import { createView, deferred } from './visibility.test-helper';
import type { ChildAgentInfo, ChildAgentTranscript } from '../../shared/child-agents';

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const iso = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
const agent: ChildAgentInfo = {
  source: 'claude-subagent', id: 'a1', agentType: 'tester', description: 'Check things', background: false, depth: 1,
  state: 'done', startedAt: iso(0), lastActivityAt: iso(41), tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
};
const transcript = (over: Partial<ChildAgentTranscript> = {}): ChildAgentTranscript => ({
  agent, prompt: 'Count the widgets', result: 'There are 3.', truncated: false,
  entries: [{ kind: 'text', text: 'Looking around' }, { kind: 'tool', name: 'Bash', summary: 'ls -la', failed: true }], ...over,
});

let view: ReturnType<typeof createView>;
let fetchTranscript: ReturnType<typeof vi.fn>;
let release: ReturnType<typeof vi.fn>;
let close: ReturnType<typeof vi.fn>;
const text = () => document.body.textContent ?? '';

async function render() {
  await view.render(React.createElement(ChildAgentViewer, { sessionId: 's1', agent, onClose: close }));
}

beforeEach(() => {
  view = createView();
  close = vi.fn();
  fetchTranscript = vi.fn().mockResolvedValue(transcript());
  release = vi.fn();
  window.electronAPI = { subagents: { transcript: fetchTranscript, releaseTranscript: release } } as unknown as typeof window.electronAPI;
});
afterEach(async () => { await view.dispose(); vi.useRealTimers(); });

describe('ChildAgentViewer', () => {
  it('shows the task, a compact activity list and the result, read-only', async () => {
    await render();
    expect(fetchTranscript).toHaveBeenCalledWith('s1', 'a1');
    expect(text()).toContain('Count the widgets');
    expect(text()).toContain('Looking around');
    expect(text()).toContain('Bash');
    expect(text()).toContain('ls -la');
    expect(text()).toContain('failed');
    expect(text()).toContain('There are 3.');
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Subagent tester');
    expect(document.querySelectorAll('input, textarea, [contenteditable]').length).toBe(0);
  });

  it('says exactly what a long transcript shows, and releases main\'s cache when it closes', async () => {
    fetchTranscript.mockResolvedValue(transcript({ truncated: true }));
    await render();
    expect(text()).toContain('Showing the task from the start and only the most recent activity. Earlier activity is not shown.');
    expect(release).not.toHaveBeenCalled();
    await view.render(null);
    expect(release).toHaveBeenCalledWith('s1', 'a1');
  });

  it('renders transcript text as text, never as markup', async () => {
    fetchTranscript.mockResolvedValue(transcript({ prompt: '<img src=x onerror=alert(1)>' }));
    await render();
    expect(document.querySelector('img')).toBeNull();
    expect(text()).toContain('<img src=x onerror=alert(1)>');
  });

  it('closes on Escape, on the close buttons and on a click outside the dialog', async () => {
    await render();
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(close).toHaveBeenCalledTimes(1);
    await act(async () => document.querySelector<HTMLElement>('.dialog-close')!.click());
    await act(async () => [...document.querySelectorAll('button')].find(b => b.textContent === 'Close')!.click());
    expect(close).toHaveBeenCalledTimes(3);
    await act(async () => { document.querySelector('.dialog-overlay')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(close).toHaveBeenCalledTimes(4);
    await act(async () => { document.querySelector('.dialog')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(close).toHaveBeenCalledTimes(4);
  });

  it('says when the transcript is gone, and while it loads', async () => {
    const pending = deferred<ChildAgentTranscript | null>();
    fetchTranscript.mockReturnValue(pending.promise);
    await render();
    expect(text()).toContain('Loading transcript');
    await act(async () => pending.resolve(null));
    expect(text()).toContain('no longer available');
  });

  it('explains an empty result for a finished and for a running agent', async () => {
    fetchTranscript.mockResolvedValue(transcript({ result: null, entries: [], prompt: null }));
    await render();
    expect(text()).toContain('No final answer was recorded.');
    expect(text()).toContain('No task text was recorded.');
    expect(text()).toContain('No tool calls or messages.');
  });

  it('keeps refreshing while the agent runs and stops when it finishes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const running = { ...agent, state: 'running' as const };
    fetchTranscript.mockResolvedValueOnce(transcript({ agent: running, result: null }))
      .mockResolvedValueOnce(transcript({ agent: running, result: null }))
      .mockResolvedValue(transcript());
    await render();
    expect(text()).toContain('Still running.');
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    expect(fetchTranscript).toHaveBeenCalledTimes(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(fetchTranscript).toHaveBeenCalledTimes(3);
    expect(text()).toContain('There are 3.');
  });

  it('labels a codex exec run and shows the note when only hook data exists', async () => {
    const exec: ChildAgentInfo = { ...agent, source: 'codex-exec', id: 'thread-1', agentType: 'codex exec' };
    fetchTranscript.mockResolvedValue(transcript({ agent: exec, prompt: null, entries: [], result: null, note: 'No rollout file was found.' }));
    await view.render(React.createElement(ChildAgentViewer, { sessionId: 's1', agent: exec, onClose: close }));
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Codex exec run codex exec');
    expect(text()).toContain('No rollout file was found.');
  });
});
