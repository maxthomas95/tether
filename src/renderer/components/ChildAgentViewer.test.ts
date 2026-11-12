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
  model: 'claude-sonnet-5-5', effort: 'medium',
  state: 'done', startedAt: iso(0), lastActivityAt: iso(41), tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
};
const runningAgent: ChildAgentInfo = { ...agent, state: 'running' };
const transcript = (over: Partial<ChildAgentTranscript> = {}): ChildAgentTranscript => ({
  agent, prompt: 'Count the widgets', result: 'There are 3.', truncated: false,
  entries: [{ kind: 'text', text: 'Looking around' }, { kind: 'tool', name: 'Bash', summary: 'ls -la', failed: true }], ...over,
});

let view: ReturnType<typeof createView>;
let fetchTranscript: ReturnType<typeof vi.fn>;
let release: ReturnType<typeof vi.fn>;
let close: ReturnType<typeof vi.fn>;
let resize: ReturnType<typeof vi.fn>;
let resizeEnd: ReturnType<typeof vi.fn>;
const text = () => view.container.textContent ?? '';
const panel = () => view.container.querySelector<HTMLElement>('.child-agent-panel')!;
const body = () => view.container.querySelector<HTMLElement>('.child-agent-panel-body')!;
const handle = () => view.container.querySelector<HTMLElement>('.child-agent-panel-resize')!;
const key = (el: Element, k: string) => act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); });

async function render(props: Partial<React.ComponentProps<typeof ChildAgentViewer>> = {}) {
  await view.render(React.createElement(ChildAgentViewer, {
    sessionId: 's1', sessionLabel: 'my session', agent, width: 400, onClose: close, onResize: resize, onResizeEnd: resizeEnd, ...props,
  }));
}

/** jsdom lays nothing out, so give the scroll area a size to scroll within. */
function sizeBody(scrollHeight: number, clientHeight: number) {
  Object.defineProperty(body(), 'scrollHeight', { configurable: true, value: scrollHeight });
  Object.defineProperty(body(), 'clientHeight', { configurable: true, value: clientHeight });
}

beforeEach(() => {
  view = createView();
  close = vi.fn();
  resize = vi.fn();
  resizeEnd = vi.fn();
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
    expect(view.container.querySelector('.child-agent-count')?.textContent).toBe('2');
    expect(view.container.querySelectorAll('input, textarea, [contenteditable]').length).toBe(0);
  });

  it('is a docked panel beside the terminals, not a dialog over them', async () => {
    await render();
    expect(panel().tagName).toBe('ASIDE');
    expect(panel().getAttribute('aria-label')).toBe('Subagent tester');
    expect(panel().style.width).toBe('400px');
    expect(panel().parentElement).toBe(view.container);
    expect(document.querySelector('[role="dialog"], [aria-modal], .dialog-overlay')).toBeNull();
  });

  it('heads the panel with the session, the agent, its summary and the model, time and tokens', async () => {
    await render();
    expect(view.container.querySelector('.child-agent-panel-eyebrow')?.textContent).toBe('Subagent · my session');
    expect(view.container.querySelector('.child-agent-panel-title')?.textContent).toBe('tester');
    expect(view.container.querySelector('.child-agent-panel-description')?.textContent).toBe('Check things');
    const meta = view.container.querySelector('.child-agent-panel-meta')!;
    expect(meta.textContent).toBe('sonnet-5-5/medium · done 41s · 7 tok');
    expect(meta.getAttribute('title')).toContain('cache read 3');
    expect(view.container.querySelector('.child-agent-panel-title .status-dot')?.className).toContain('status-dot--idle');
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
    fetchTranscript.mockResolvedValue(transcript({ prompt: '<img src=x onerror=alert(1)>', result: '<b>bold</b>' }));
    await render();
    expect(view.container.querySelector('img, b')).toBeNull();
    expect(text()).toContain('<img src=x onerror=alert(1)>');
    expect(text()).toContain('<b>bold</b>');
  });

  it('closes from its close button, and from Escape only while focus is inside it', async () => {
    await render();
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(close).not.toHaveBeenCalled();
    await key(body(), 'Escape');
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenLastCalledWith(true);
    await act(async () => view.container.querySelector<HTMLElement>('[aria-label="Close subagent panel"]')!.click());
    expect(close).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenLastCalledWith();
  });

  it('takes focus only when it was opened from the keyboard', async () => {
    await render();
    expect(document.activeElement).not.toBe(panel());
    await view.render(null);
    await render({ focusOnOpen: true });
    expect(document.activeElement).toBe(panel());
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

  it('shows the whole answer in the one scroll area, and says when its end is missing', async () => {
    const answer = `${'line\n'.repeat(3000)}END`;
    fetchTranscript.mockResolvedValue(transcript({ result: answer }));
    await render();
    expect(view.container.querySelector('.child-agent-text--result')?.textContent).toBe(answer);
    expect(text()).not.toContain('its end is missing');
    fetchTranscript.mockResolvedValue(transcript({ result: answer, resultTruncated: true }));
    await view.render(null);
    await render();
    expect(text()).toContain('The answer is longer than Tether shows; its end is missing.');
  });

  it('folds a long task behind a toggle and leaves a short one alone', async () => {
    await render();
    expect(view.container.querySelector('.child-agent-fold')).toBeNull();
    await view.render(null);
    fetchTranscript.mockResolvedValue(transcript({ prompt: 'step\n'.repeat(40) }));
    await render();
    const fold = view.container.querySelector<HTMLButtonElement>('.child-agent-fold')!;
    expect(fold.textContent).toBe('Show full task');
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(view.container.querySelector('.child-agent-text--folded')).not.toBeNull();
    await act(async () => fold.click());
    expect(fold.textContent).toBe('Show less');
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    expect(view.container.querySelector('.child-agent-text--folded')).toBeNull();
  });

  it('gives a long tool line its full text on hover', async () => {
    const summary = `npm test -- ${'x'.repeat(140)}`;
    fetchTranscript.mockResolvedValue(transcript({ entries: [{ kind: 'tool', name: 'Bash', summary }] }));
    await render();
    expect(view.container.querySelector('.child-agent-tool-summary')?.getAttribute('title')).toBe(summary);
  });

  it('keeps refreshing while the agent runs and stops when it finishes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fetchTranscript.mockResolvedValueOnce(transcript({ agent: runningAgent, result: null }))
      .mockResolvedValueOnce(transcript({ agent: runningAgent, result: null }))
      .mockResolvedValue(transcript());
    await render({ agent: runningAgent });
    expect(text()).toContain('Still running.');
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    expect(fetchTranscript).toHaveBeenCalledTimes(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(fetchTranscript).toHaveBeenCalledTimes(3);
    expect(text()).toContain('There are 3.');
  });

  it('reads the answer as soon as the sidebar row reports the end, without waiting for the next poll', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fetchTranscript.mockResolvedValueOnce(transcript({ agent: runningAgent, result: null })).mockResolvedValue(transcript());
    await render({ agent: runningAgent });
    expect(text()).toContain('Still running.');
    await render({ agent });
    expect(fetchTranscript).toHaveBeenCalledTimes(2);
    expect(text()).toContain('There are 3.');
    // The poll that was pending is gone with it.
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(fetchTranscript).toHaveBeenCalledTimes(2);
  });

  it('does not add reads for activity on an agent it is already polling', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fetchTranscript.mockResolvedValue(transcript({ agent: runningAgent, result: null }));
    await render({ agent: runningAgent });
    await render({ agent: { ...runningAgent, lastActivityAt: iso(50) } });
    await render({ agent: { ...runningAgent, lastActivityAt: iso(52) } });
    expect(fetchTranscript).toHaveBeenCalledTimes(1);
  });

  it('picks the work up again when a finished agent is resumed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fetchTranscript.mockResolvedValueOnce(transcript({ agent, result: null }));
    await render();
    expect(fetchTranscript).toHaveBeenCalledTimes(1);
    // Finished and idle: nothing is polled.
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(fetchTranscript).toHaveBeenCalledTimes(1);
    // The agent is resumed: the row flips to running and the panel picks the work up again.
    fetchTranscript.mockResolvedValue(transcript({ agent: runningAgent, result: null, entries: [{ kind: 'tool', name: 'Read', summary: 'a.ts' }] }));
    await render({ agent: { ...runningAgent, lastActivityAt: iso(90) } });
    expect(fetchTranscript).toHaveBeenCalledTimes(2);
    expect(text()).toContain('a.ts');
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    expect(fetchTranscript).toHaveBeenCalledTimes(3);
  });

  it('retries a failed read of a running agent a few times, keeps what it had, and says it may be behind', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fetchTranscript.mockResolvedValueOnce(transcript({ agent: runningAgent, result: null })).mockResolvedValue(null);
    await render({ agent: runningAgent });
    expect(text()).not.toContain('may be out of date');
    for (let i = 0; i < 6; i++) await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    // One good read, then three failed ones, then it stops asking.
    expect(fetchTranscript).toHaveBeenCalledTimes(4);
    expect(text()).toContain('Looking around');
    expect(text()).toContain('Tether can no longer read this transcript, so what is shown may be out of date.');
    expect(text()).not.toContain('Still running.');
  });

  it('stays at the newest activity while the agent works, unless the reader scrolled away', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // Every read is a new object over IPC, as it is in the app.
    fetchTranscript.mockImplementation(async () => transcript({ agent: runningAgent, result: null }));
    await render({ agent: runningAgent });
    sizeBody(1000, 200);
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    expect(body().scrollTop).toBe(1000);

    // The reader scrolls up to read something earlier: new activity no longer moves the view.
    await act(async () => { body().scrollTop = 100; body().dispatchEvent(new Event('scroll')); });
    sizeBody(1400, 200);
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    expect(body().scrollTop).toBe(100);

    // Back at the end, following resumes.
    await act(async () => { body().scrollTop = 1200; body().dispatchEvent(new Event('scroll')); });
    sizeBody(1800, 200);
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    expect(body().scrollTop).toBe(1800);
  });

  it('opens a finished agent at its answer, and moves there when a followed run ends', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const offsetTop = vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockReturnValue(640);
    try {
      await render();
      expect(body().scrollTop).toBe(632);
      await view.render(null);

      fetchTranscript.mockImplementationOnce(async () => transcript({ agent: runningAgent, result: null }))
        .mockImplementation(async () => transcript());
      await render({ agent: runningAgent });
      sizeBody(2000, 200);
      await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
      // Not the very end: the start of the answer.
      expect(body().scrollTop).toBe(632);
    } finally {
      offsetTop.mockRestore();
    }
  });

  it('resizes from the keyboard handle within its bounds and reports the final width', async () => {
    await render();
    expect(handle().getAttribute('role')).toBe('separator');
    expect(handle().getAttribute('aria-valuenow')).toBe('400');
    await key(handle(), 'ArrowLeft');
    expect(resize).toHaveBeenLastCalledWith(424);
    expect(resizeEnd).toHaveBeenLastCalledWith(424);
    await key(handle(), 'ArrowRight');
    expect(resize).toHaveBeenLastCalledWith(376);
    await render({ width: 720 });
    await key(handle(), 'ArrowLeft');
    expect(resize).toHaveBeenLastCalledWith(720);
    await key(handle(), 'Enter');
    expect(resize).toHaveBeenCalledTimes(3);
  });

  it('resizes by dragging its left edge, measured from the panel\'s right edge', async () => {
    await render();
    panel().getBoundingClientRect = () => ({ right: 1200 } as DOMRect);
    await act(async () => { handle().dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 800 })); });
    await act(async () => { document.dispatchEvent(new MouseEvent('mousemove', { clientX: 700 })); });
    expect(resize).toHaveBeenLastCalledWith(500);
    await act(async () => { document.dispatchEvent(new MouseEvent('mousemove', { clientX: 1100 })); });
    expect(resize).toHaveBeenLastCalledWith(280);
    expect(resizeEnd).not.toHaveBeenCalled();
    await act(async () => { document.dispatchEvent(new MouseEvent('mouseup')); });
    expect(resizeEnd).toHaveBeenCalledWith(280);
    await act(async () => { document.dispatchEvent(new MouseEvent('mousemove', { clientX: 600 })); });
    expect(resize).toHaveBeenCalledTimes(2);
    expect(document.body.style.cursor).toBe('');
  });

  it('labels a codex exec run and shows the note when only hook data exists', async () => {
    const exec: ChildAgentInfo = { ...agent, source: 'codex-exec', id: 'thread-1', agentType: 'codex exec' };
    fetchTranscript.mockResolvedValue(transcript({ agent: exec, prompt: null, entries: [], result: null, note: 'No rollout file was found.' }));
    await render({ agent: exec, sessionLabel: undefined });
    expect(panel().getAttribute('aria-label')).toBe('Codex exec run codex exec');
    expect(view.container.querySelector('.child-agent-panel-eyebrow')?.textContent).toBe('Codex exec run');
    expect(text()).toContain('No rollout file was found.');
  });
});
