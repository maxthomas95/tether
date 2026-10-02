// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PipPanel } from './PipPanel';
import { DEFAULT_PIP_SETTINGS, type PipSettings } from '../../lib/pip-settings';
import { PIP_COMMENT_COOLDOWN_MS, PIP_EXPRESSION_MS, PIP_NAP_DELAY_MS, PIP_SPEECH_MS, type PipSession } from '../../lib/pip-behavior';
import { reportPipActivity } from '../../lib/pip-activity';

let container: HTMLDivElement;
let root: Root;
let settings: PipSettings;
let sessions: PipSession[];
let focused: string | null;
let hidden: boolean;
let reduced: boolean;
let mediaChange: () => void;
const save = vi.fn();
const activate = vi.fn();

async function render() {
  await act(async () => root.render(createElement(PipPanel, {
    settings, sessions, activeSessionId: focused, busy: false, onSettingsChange: save, onActivateSession: activate,
  })));
}
async function click(selector: string) { await act(async () => (container.querySelector(selector) as HTMLElement).click()); }
async function advance(ms: number) { await act(async () => vi.advanceTimersByTime(ms)); }
function panel() { return container.querySelector<HTMLElement>('.pip-panel')!; }
function line() { return container.querySelector('.pip-speech')?.textContent; }
async function state(state: PipSession['state'], waitingReason?: PipSession['waitingReason']) {
  sessions = sessions.map(session => session.id === focused ? { ...session, state, waitingReason } : session);
  await render();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  hidden = reduced = false;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  vi.stubGlobal('matchMedia', () => ({ get matches() { return reduced; }, addEventListener: (_: string, callback: () => void) => { mediaChange = callback; }, removeEventListener: vi.fn() }));
  settings = { ...DEFAULT_PIP_SETTINGS, enabled: true };
  sessions = [
    { id: 'a', label: 'tether', workingDir: '/repo/tether', state: 'running' },
    { id: 'b', label: 'jobs', workingDir: '/repo/jobs', state: 'running' },
    { id: 'c', label: 'scratchpad', workingDir: '/repo/scratchpad', state: 'idle' },
  ];
  focused = 'a';
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  expect(vi.getTimerCount()).toBe(0);
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Pip sidebar interactions', () => {
  it('reacts only to focused terminal activity and clears typing on submit or collapse', async () => {
    await render();
    await act(async () => reportPipActivity('b'));
    expect(panel().dataset.mood).toBe('busy');
    await act(async () => reportPipActivity('a'));
    expect(panel().dataset.mood).toBe('typing');
    await act(async () => reportPipActivity('a', true));
    expect(panel().dataset.mood).toBe('curious');
    expect(line()).toContain('idea');
    await act(async () => reportPipActivity('a'));
    settings = { ...settings, collapsed: true };
    await render();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stays awake during focused terminal input even when xterm stops DOM key propagation', async () => {
    await render();
    await advance(PIP_NAP_DELAY_MS - 500);
    await act(async () => reportPipActivity('a'));
    await advance(600);
    expect(panel().dataset.mood).toBe('typing');
    await advance(1200);
    expect(panel().dataset.mood).toBe('busy');
  });

  it('ignores a delayed AI reply after switching focus and cancels the request', async () => {
    let resolve!: (value: unknown) => void;
    const comment = vi.fn(() => new Promise(done => { resolve = done; }));
    const cancelComment = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('electronAPI', { pip: { comment, cancelComment } });
    settings = { ...settings, aiComments: true };
    await render();
    await state('waiting', 'permission');
    await advance(600);
    expect(comment).toHaveBeenCalledWith({ event: 'permission', sessionId: 'a' });
    focused = 'b';
    await render();
    expect(cancelComment).toHaveBeenCalled();
    await act(async () => resolve({ status: 'ready', line: 'Stale quip', model: 'gpt-6-luna', reason: null }));
    expect(line()).not.toBe('Stale quip');
  });

  it('keeps AI requests off by default and exposes separate prompt consent', async () => {
    const comment = vi.fn();
    vi.stubGlobal('electronAPI', { pip: { comment } });
    await render();
    await state('waiting', 'permission');
    await advance(600);
    expect(comment).not.toHaveBeenCalled();
    await click('.pip-options-toggle');
    const aiToggle = Array.from(container.querySelectorAll('label')).find(label => label.textContent?.includes('AI quips'))!.querySelector('input')!;
    await act(async () => aiToggle.click());
    expect(save).toHaveBeenLastCalledWith({ aiComments: true });
    expect(container.textContent).not.toContain('Share submitted prompts');
    settings = { ...settings, aiComments: true };
    await render();
    expect(container.textContent).toContain('Share submitted prompts');
  });
  it('follows real focus and lets keyboard-compatible petting respond immediately', async () => {
    await render();
    expect(panel().dataset.mood).toBe('busy');
    focused = 'b';
    await render();
    expect(container.querySelector('.pip-following')?.textContent).toBe('Following jobs');
    expect(line()).toContain('jobs');
    await click('.pip-pet-button');
    expect(panel().dataset.mood).toBe('happy');
    expect(line()).toContain('Compensation');
    await advance(PIP_EXPRESSION_MS);
    expect(panel().dataset.mood).toBe('busy');
    await advance(PIP_SPEECH_MS);
    expect(line()).toBe('I supervise. You do the keyboard stuff.');
  });

  it('rate-limits automatic speech while keeping expressions responsive', async () => {
    await render();
    await state('waiting', 'permission');
    expect(panel().dataset.mood).toBe('permission');
    expect(line()).toContain('Permission');
    await state('running');
    expect(panel().dataset.mood).toBe('busy');
    expect(line()).toBe('I supervise. You do the keyboard stuff.');
    await advance(PIP_COMMENT_COOLDOWN_MS);
    await state('waiting', 'idle');
    expect(panel().dataset.mood).toBe('happy');
    expect(line()).not.toBe('I supervise. You do the keyboard stuff.');
    expect(line()).not.toMatch(/succeed|completed|passed/);
  });

  it('gets dizzy during rapid focus changes and returns to current status', async () => {
    await render();
    for (const id of ['b', 'a', 'b', 'a']) { focused = id; await render(); }
    expect(panel().dataset.mood).toBe('dizzy');
    await advance(PIP_EXPRESSION_MS);
    expect(panel().dataset.mood).toBe('busy');
  });

  it('jumps to a background permission prompt before an ordinary input wait', async () => {
    await render();
    sessions = sessions.map(session => session.id === 'a' ? session : { ...session, state: 'waiting', waitingReason: session.id === 'c' ? 'permission' : 'idle' });
    await render();
    expect(panel().dataset.mood).toBe('permission');
    expect(container.querySelector('.pip-waiting')?.textContent).toContain('2 waiting');
    await click('.pip-waiting');
    expect(activate).toHaveBeenCalledWith('c');
  });

  it('renders untrusted labels as text and handles a removed focused session', async () => {
    await render();
    focused = 'b';
    sessions = sessions.map(session => session.id === 'b' ? { ...session, label: '<img src=x onerror=alert(1)>' } : session);
    await render();
    expect(line()).toContain('<img');
    expect(container.querySelector('img')).toBeNull();
    sessions = [];
    focused = null;
    await render();
    await advance(PIP_EXPRESSION_MS);
    expect(panel().dataset.mood).toBe('curious');
    expect(container.querySelector('.pip-following')?.textContent).toBe('Keeping you company');
  });

  it('quiet mode preserves expressions and switches personality without a new event', async () => {
    settings.quiet = true;
    await render();
    await state('waiting', 'permission');
    await click('.pip-pet-button');
    expect(panel().dataset.mood).toBe('happy');
    expect(line()).toBe('Quiet company. Same tiny supervisor.');
    settings = { ...settings, quiet: false, personality: 'sweet' };
    await render();
    await click('.pip-pet-button');
    expect(line()).toBe('You made my whole afternoon.');
    settings = { ...settings, personality: 'dry' };
    await render();
    expect(line()).toBe('Finally. My performance review.');
  });

  it('saves presentation controls, collapse, and hide through the parent', async () => {
    await render();
    await click('.pip-quiet input');
    expect(save).toHaveBeenLastCalledWith({ quiet: true });
    await click('.pip-options-toggle');
    await act(async () => {
      const select = container.querySelector('select')!;
      select.value = 'sweet';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(save).toHaveBeenLastCalledWith({ personality: 'sweet' });
    await click('.pip-options input');
    expect(save).toHaveBeenLastCalledWith({ motion: false });
    await click('.pip-heading');
    expect(save).toHaveBeenLastCalledWith({ collapsed: true });
    await click('[aria-label="Hide Pip"]');
    expect(save).toHaveBeenLastCalledWith({ enabled: false });
  });

  it('naps after inactivity and wakes on app input', async () => {
    await render();
    await advance(PIP_NAP_DELAY_MS);
    expect(panel().dataset.mood).toBe('sleepy');
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' })));
    expect(panel().dataset.mood).toBe('busy');
    expect(line()).toBe('I supervise. You do the keyboard stuff.');
  });

  it.each(['collapsed', 'hidden', 'disabled'] as const)('suspends timers and missed reactions when %s', async suspension => {
    await render();
    if (suspension === 'hidden') {
      hidden = true;
      await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    } else {
      settings = { ...settings, collapsed: suspension === 'collapsed', enabled: suspension !== 'disabled' };
      await render();
    }
    expect(container.querySelector('.pip-creature')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await state('waiting', 'permission');
    await advance(PIP_NAP_DELAY_MS * 2);
    expect(vi.getTimerCount()).toBe(0);
    settings = { ...settings, collapsed: false, enabled: true };
    hidden = false;
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    await render();
    expect(panel().dataset.mood).toBe('permission');
    expect(line()).toBe('I supervise. You do the keyboard stuff.');
  });

  it('honors reduced motion, its live changes, and the saved motion preference', async () => {
    reduced = true;
    await render();
    expect(panel().dataset.motion).toBe('false');
    reduced = false;
    await act(async () => mediaChange());
    expect(panel().dataset.motion).toBe('true');
    await act(async () => document.dispatchEvent(new MouseEvent('pointermove', { clientX: 300, clientY: 300 })));
    expect(panel().style.getPropertyValue('--pip-gaze-x')).toBe('3px');
    await act(async () => document.dispatchEvent(new Event('pointerleave')));
    expect(panel().style.getPropertyValue('--pip-gaze-x')).toBe('0px');
    settings = { ...settings, motion: false };
    await render();
    expect(panel().dataset.motion).toBe('false');
    expect(panel().style.getPropertyValue('--pip-gaze-x')).toBe('0px');
  });
});
