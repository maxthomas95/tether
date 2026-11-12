// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipNudge } from '../../lib/pip-nudges';

// The real feed reads quota, usage and Vault; here the test plays its part.
const feed = vi.hoisted(() => ({ onChange: null as ((nudges: readonly unknown[]) => void) | null, updateVersion: undefined as string | null | undefined }));
vi.mock('./PipNudgeFeed', () => ({
  PipNudgeFeed: (props: { updateVersion: string | null; onChange: (nudges: readonly unknown[]) => void }) => {
    feed.onChange = props.onChange;
    feed.updateVersion = props.updateVersion;
    return null;
  },
}));

import { PipPanel } from './PipPanel';
import { DEFAULT_PIP_SETTINGS, type PipSettings } from '../../lib/pip-settings';
import { PIP_COMMENT_COOLDOWN_MS, PIP_EXPRESSION_MS, PIP_NAP_DELAY_MS, PIP_SPEECH_MS, type PipSession } from '../../lib/pip-behavior';
import { reportPipActivity } from '../../lib/pip-activity';
import { PIP_AI_WAIT_MS } from '../../hooks/usePip';

let container: HTMLDivElement;
let root: Root;
let settings: PipSettings;
let sessions: PipSession[];
let focused: string | null;
let childCounts: ReadonlyMap<string, number> | undefined;
let hidden: boolean;
let reduced: boolean;
let mediaChange: () => void;
const save = vi.fn();
const activate = vi.fn();

async function render() {
  await act(async () => root.render(createElement(PipPanel, {
    settings, sessions, activeSessionId: focused, childCounts, busy: false, onSettingsChange: save, onActivateSession: activate,
  })));
}
async function nudge(...nudges: PipNudge[]) { await act(async () => feed.onChange?.(nudges)); }
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
  // Frames run on the fake clock, and an uncancelled frame counts as a leaked timer.
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 16));
  vi.stubGlobal('cancelAnimationFrame', (frame: number) => clearTimeout(frame));
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
  childCounts = undefined;
  feed.onChange = null;
  feed.updateVersion = undefined;
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

  it('gives a late AI quip a full window from when it lands', async () => {
    let resolve!: (value: unknown) => void;
    const comment = vi.fn(() => new Promise(done => { resolve = done; }));
    vi.stubGlobal('electronAPI', { pip: { comment, cancelComment: vi.fn().mockResolvedValue(undefined) } });
    settings = { ...settings, aiComments: true };
    await render();
    await state('waiting', 'permission');
    const local = line();
    await advance(600);
    // The local line outlives its own 12 seconds while the quip is on its way.
    await advance(PIP_SPEECH_MS + 2000);
    expect(line()).toBe(local);
    await act(async () => resolve({ status: 'ready', line: 'Worth the wait.', model: 'gpt-6-luna', reason: null }));
    expect(line()).toBe('Worth the wait.');
    await advance(PIP_SPEECH_MS - 1);
    expect(line()).toBe('Worth the wait.');
    await advance(1);
    expect(line()).not.toBe('Worth the wait.');
    expect(line()).not.toBe(local);
  });

  it('lets the local line keep only its own time when no quip comes back', async () => {
    let resolve!: (value: unknown) => void;
    const comment = vi.fn(() => new Promise(done => { resolve = done; }));
    vi.stubGlobal('electronAPI', { pip: { comment, cancelComment: vi.fn().mockResolvedValue(undefined) } });
    settings = { ...settings, aiComments: true };
    await render();
    await state('waiting', 'permission');
    const local = line();
    await advance(600 + 4000);
    await act(async () => resolve({ status: 'unavailable', line: null, model: null, reason: 'AI comments unavailable. Using local quips.' }));
    await advance(PIP_SPEECH_MS - 4600 - 1);
    expect(line()).toBe(local);
    await advance(1);
    expect(line()).not.toBe(local);
  });

  it('does not hold a line forever for a reply that never arrives', async () => {
    const comment = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal('electronAPI', { pip: { comment, cancelComment: vi.fn().mockResolvedValue(undefined) } });
    settings = { ...settings, aiComments: true };
    await render();
    await state('waiting', 'permission');
    const local = line();
    await advance(600);
    await advance(PIP_AI_WAIT_MS - 600 - 1);
    expect(line()).toBe(local);
    await advance(1);
    expect(line()).not.toBe(local);
  });

  it('sends nothing for a moment that ends before the request goes out', async () => {
    const comment = vi.fn();
    const cancelComment = vi.fn();
    vi.stubGlobal('electronAPI', { pip: { comment, cancelComment } });
    settings = { ...settings, aiComments: true };
    await render();
    await state('waiting', 'permission');
    await advance(300);
    await state('running');
    await advance(PIP_SPEECH_MS);
    expect(comment).not.toHaveBeenCalled();
    expect(cancelComment).not.toHaveBeenCalled();
  });

  it('leaves the AI cooldown to main and shows the reason it gives back', async () => {
    const comment = vi.fn()
      .mockResolvedValueOnce({ status: 'ready', line: 'First quip.', model: 'gpt-6-luna', reason: null })
      .mockResolvedValueOnce({ status: 'paused', line: null, model: null, reason: 'Taking a breather between AI comments.' });
    vi.stubGlobal('electronAPI', { pip: { comment, cancelComment: vi.fn().mockResolvedValue(undefined) } });
    settings = { ...settings, aiComments: true };
    await render();
    await click('.pip-options-toggle');
    await state('waiting', 'permission');
    await advance(600);
    expect(line()).toBe('First quip.');
    await state('running');
    await state('waiting', 'permission');
    await advance(600);
    expect(comment).toHaveBeenCalledTimes(2);
    expect(container.querySelector('.pip-ai-status')?.textContent).toBe('Taking a breather between AI comments.');
    expect(line()).not.toBe('First quip.');
  });

  it('asks for a quip when a long turn hands back', async () => {
    const comment = vi.fn().mockResolvedValue({ status: 'ready', line: 'Marathon done.', model: 'gpt-6-luna', reason: null });
    vi.stubGlobal('electronAPI', { pip: { comment, cancelComment: vi.fn().mockResolvedValue(undefined) } });
    settings = { ...settings, aiComments: true };
    await render();
    await state('idle');
    await advance(PIP_COMMENT_COOLDOWN_MS);
    await state('running');
    await advance(6 * 60_000);
    await state('waiting', 'input');
    await advance(600);
    expect(comment).toHaveBeenLastCalledWith({ event: 'longTurn', sessionId: 'a' });
    expect(line()).toBe('Marathon done.');
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
    expect(line()).toBe('Finally. My performance review.');
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
    const read = vi.spyOn(container.querySelector('.pip-pet-button')!, 'getBoundingClientRect');
    await act(async () => {
      for (const clientX of [100, 200, 300]) document.dispatchEvent(new MouseEvent('pointermove', { clientX, clientY: 300 }));
    });
    expect(read).not.toHaveBeenCalled();
    await advance(20);
    expect(read).toHaveBeenCalledTimes(1);
    expect(panel().style.getPropertyValue('--pip-gaze-x')).toBe('3px');
    await act(async () => document.dispatchEvent(new MouseEvent('pointermove', { clientX: 300, clientY: 300 })));
    await act(async () => document.dispatchEvent(new Event('pointerleave')));
    expect(panel().style.getPropertyValue('--pip-gaze-x')).toBe('0px');
    settings = { ...settings, motion: false };
    await render();
    expect(panel().dataset.motion).toBe('false');
    expect(panel().style.getPropertyValue('--pip-gaze-x')).toBe('0px');
  });

  it('keeps the Enter quip while the agent starts working and still speaks for a permission prompt', async () => {
    sessions = sessions.map(session => session.id === 'a' ? { ...session, state: 'waiting', waitingReason: 'idle' } : session);
    await render();
    await act(async () => reportPipActivity('a', true));
    expect(line()).toContain('idea');
    await state('running');
    expect(panel().dataset.mood).toBe('busy');
    expect(line()).toContain('idea');
    await advance(5000);
    await state('waiting', 'permission');
    expect(panel().dataset.mood).toBe('permission');
    expect(line()).toBe("Permission slip, please. I don't have thumbs.");
  });

  it('lets a ready line replace a routine one and retires it when the agent resumes', async () => {
    await render();
    await act(async () => reportPipActivity('a', true));
    expect(line()).toContain('idea');
    await advance(3000);
    await state('waiting', 'idle');
    expect(line()).toBe("They're ready for you. I'm ready for snacks.");
    await act(async () => reportPipActivity('a', true));
    expect(line()).toBe("They're ready for you. I'm ready for snacks.");
    await state('running');
    expect(line()).toBe('I supervise. You do the keyboard stuff.');
  });

  it('wakes for a background permission prompt and stays alert until it is answered', async () => {
    const background = (state: PipSession['state'], waitingReason?: PipSession['waitingReason']) => {
      sessions = sessions.map(session => session.id === 'c' ? { ...session, state, waitingReason } : session);
      return render();
    };
    await render();
    await advance(PIP_NAP_DELAY_MS);
    expect(panel().dataset.mood).toBe('sleepy');
    await background('waiting', 'permission');
    expect(panel().dataset.mood).toBe('permission');
    expect(line()).toContain('scratchpad');
    await advance(PIP_EXPRESSION_MS + PIP_SPEECH_MS + PIP_NAP_DELAY_MS);
    expect(panel().dataset.mood).toBe('permission');
    expect(container.querySelector('.pip-emote')?.textContent).toBe('?');
    expect(vi.getTimerCount()).toBe(0);
    await background('running');
    expect(panel().dataset.mood).toBe('busy');
    await advance(PIP_NAP_DELAY_MS);
    expect(panel().dataset.mood).toBe('sleepy');
  });

  it('wakes for an ordinary background wait, then naps again', async () => {
    await render();
    await advance(PIP_NAP_DELAY_MS);
    expect(panel().dataset.mood).toBe('sleepy');
    sessions = sessions.map(session => session.id === 'b' ? { ...session, state: 'waiting', waitingReason: 'idle' } : session);
    await render();
    expect(panel().dataset.mood).toBe('permission');
    expect(line()).toContain('jobs');
    await advance(PIP_EXPRESSION_MS);
    expect(panel().dataset.mood).toBe('busy');
    await advance(PIP_NAP_DELAY_MS);
    expect(panel().dataset.mood).toBe('sleepy');
  });

  it('does not nap while the focused session waits on a permission prompt', async () => {
    await render();
    await state('waiting', 'permission');
    await advance(PIP_NAP_DELAY_MS * 2);
    expect(panel().dataset.mood).toBe('permission');
    await state('running');
    await advance(PIP_NAP_DELAY_MS);
    expect(panel().dataset.mood).toBe('sleepy');
  });

  it('keeps the waiting shortcut in the header while collapsed', async () => {
    settings = { ...settings, collapsed: true };
    sessions = sessions.map(session => session.id === 'b' ? { ...session, state: 'waiting', waitingReason: 'permission' } : session);
    await render();
    expect(container.querySelector('.pip-content')).toBeNull();
    expect(container.querySelector('.pip-header .pip-waiting')?.textContent).toContain('1 waiting');
    await click('.pip-header .pip-waiting');
    expect(activate).toHaveBeenCalledWith('b');
    expect(vi.getTimerCount()).toBe(0);
    settings = { ...settings, collapsed: false };
    await render();
    expect(container.querySelector('.pip-header .pip-waiting')).toBeNull();
    expect(container.querySelector('.pip-footer .pip-waiting')?.textContent).toContain('1 waiting');
  });

  it('announces only lines about a session that needs you', async () => {
    const announced = () => container.querySelector('.pip-announcement')?.textContent;
    await render();
    expect(container.querySelector('.pip-speech')?.getAttribute('aria-live')).toBeNull();
    expect(container.querySelector('.pip-speech')?.getAttribute('role')).toBeNull();
    expect(container.querySelector('.pip-announcement')?.getAttribute('role')).toBe('status');
    focused = 'b';
    await render();
    expect(line()).toContain('jobs');
    expect(announced()).toBe('');
    await click('.pip-pet-button');
    expect(announced()).toBe('');
    sessions = sessions.map(session => session.id === 'c' ? { ...session, state: 'waiting', waitingReason: 'permission' } : session);
    await render();
    expect(announced()).toBe(line());
    expect(announced()).toContain('scratchpad');
    await advance(PIP_SPEECH_MS);
    expect(announced()).toBe('');
  });

  it('announces the local line when an AI quip replaces it, and nothing in quiet mode', async () => {
    const comment = vi.fn().mockResolvedValue({ status: 'ready', line: 'A generated quip.', model: 'gpt-6-luna', reason: null });
    vi.stubGlobal('electronAPI', { pip: { comment, cancelComment: vi.fn().mockResolvedValue(undefined) } });
    settings = { ...settings, aiComments: true };
    await render();
    await state('waiting', 'permission');
    const local = line();
    await advance(600);
    expect(line()).toBe('A generated quip.');
    expect(container.querySelector('.pip-announcement')?.textContent).toBe(local);
    settings = { ...settings, quiet: true };
    await render();
    expect(container.querySelector('.pip-announcement')?.textContent).toBe('');
  });

  it('keeps one nap timer however much the pointer moves', async () => {
    await render();
    const timers = vi.getTimerCount();
    await advance(PIP_NAP_DELAY_MS - 1000);
    await act(async () => {
      for (let index = 0; index < 50; index += 1) document.dispatchEvent(new MouseEvent('pointerdown'));
    });
    expect(vi.getTimerCount()).toBe(timers);
    await advance(1000);
    expect(panel().dataset.mood).toBe('busy');
    await advance(PIP_NAP_DELAY_MS - 1000);
    expect(panel().dataset.mood).toBe('sleepy');
  });

  it('wakes fully when typing ends a nap', async () => {
    await render();
    await advance(PIP_NAP_DELAY_MS);
    expect(panel().dataset.mood).toBe('sleepy');
    expect(line()).toContain('Wake me');
    await act(async () => reportPipActivity('a'));
    expect(panel().dataset.mood).toBe('typing');
    expect(line()).toBe('I supervise. You do the keyboard stuff.');
    await advance(1200);
    expect(panel().dataset.mood).toBe('busy');
  });

  it('works through an event\'s lines before repeating one', async () => {
    await render();
    const seen: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      await click('.pip-pet-button');
      seen.push(line() ?? '');
    }
    expect(new Set(seen.slice(0, 6)).size).toBe(6);
    expect(seen[6]).toBe(seen[0]);
    focused = 'b';
    await render();
    await click('.pip-pet-button');
    expect(line()).toBe(seen[1]);
  });

  it('remarks on a long turn when the agent hands back', async () => {
    sessions = sessions.map(session => session.id === 'a' ? { ...session, state: 'waiting', waitingReason: 'idle' } : session);
    await render();
    await state('running');
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' })));
    await advance(7 * 60_000 + 5000);
    await state('waiting', 'idle');
    expect(panel().dataset.mood).toBe('happy');
    expect(line()).toBe('7 minutes. I aged visibly. Your turn.');
    await state('running');
    expect(line()).toBe('I supervise. You do the keyboard stuff.');
  });

  it('reacts to a crash and to helpers joining the focused session', async () => {
    await render();
    childCounts = new Map([['a', 2]]);
    await render();
    expect(line()).toBe('It hired interns. I was not consulted.');
    expect(container.querySelector('.pip-emote')?.textContent).toBe('+');
    await state('dead');
    expect(panel().dataset.mood).toBe('concerned');
    expect(line()).toBe('That session ended badly. I saw nothing.');
    expect(container.querySelector('.pip-announcement')?.textContent).toBe('');
  });

  it('keeps operational nudges off until asked, then mentions each occurrence once', async () => {
    const update: PipNudge = { key: 'update:0.8.0', kind: 'updateAvailable', detail: 'v0.8.0' };
    await render();
    expect(feed.onChange).toBeNull();
    await click('.pip-options-toggle');
    const toggle = Array.from(container.querySelectorAll('label')).find(label => label.textContent?.includes('Operational nudges'))!.querySelector('input')!;
    await act(async () => toggle.click());
    expect(save).toHaveBeenLastCalledWith({ nudges: true });
    settings = { ...settings, nudges: true };
    await render();
    expect(feed.onChange).not.toBeNull();
    await nudge(update);
    expect(line()).toBe('Tether v0.8.0 is out. I hear the new me is the same.');
    expect(panel().dataset.mood).toBe('happy');
    expect(container.querySelector('.pip-announcement')?.textContent).toBe('');
    await advance(PIP_SPEECH_MS);
    await nudge({ ...update });
    await nudge();
    await nudge(update);
    expect(line()).toBe('I supervise. You do the keyboard stuff.');
  });

  it('waits for a live line, then speaks one nudge per kind', async () => {
    settings = { ...settings, nudges: true };
    await render();
    await state('waiting', 'permission');
    const permissionLine = line();
    await nudge(
      { key: 'quota:claude-5h:x', kind: 'quotaHigh', detail: 'Claude 5-hour limit' },
      { key: 'quota:claude-7d:x', kind: 'quotaHigh', detail: 'Claude weekly limit' },
      { key: 'budget:daily:2026-11-12', kind: 'budgetCrossed', detail: 'daily' },
    );
    expect(line()).toBe(permissionLine);
    await advance(PIP_SPEECH_MS);
    expect(line()).toBe('Your Claude 5-hour limit is nearly used up. Pace yourself.');
    await advance(PIP_SPEECH_MS);
    expect(line()).toBe('You passed your daily budget. I bill less.');
    await advance(PIP_SPEECH_MS);
    expect(line()).toBe('I supervise. You do the keyboard stuff.');
    expect(panel().dataset.mood).toBe('permission');
  });

  it('shows a nudge as posture only in quiet mode, and passes the update version to the feed', async () => {
    settings = { ...settings, nudges: true, quiet: true };
    await act(async () => root.render(createElement(PipPanel, {
      settings, sessions, activeSessionId: focused, updateVersion: '0.8.0', busy: false, onSettingsChange: save, onActivateSession: activate,
    })));
    expect(feed.updateVersion).toBe('0.8.0');
    await nudge({ key: 'vault:soon', kind: 'vaultExpiring', detail: '5 minutes' });
    expect(panel().dataset.mood).toBe('concerned');
    expect(line()).toBe('Quiet company. Same tiny supervisor.');
    await advance(PIP_EXPRESSION_MS);
    expect(panel().dataset.mood).toBe('busy');
  });
});
