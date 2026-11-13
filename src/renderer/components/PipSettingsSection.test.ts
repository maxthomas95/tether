// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PipSettingsSection } from './PipSettingsSection';
import { DEFAULT_PIP_SETTINGS, type PipSettings } from '../../shared/pip';

let container: HTMLDivElement;
let root: Root;
let settings: PipSettings | null;
const update = vi.fn(async () => {});

async function render(busy = false) {
  await act(async () => root.render(createElement(PipSettingsSection, { settings, busy, update })));
}
function control<T extends HTMLElement>(label: string): T {
  const found = Array.from(container.querySelectorAll('label')).find(item => item.textContent?.trim().startsWith(label));
  if (!found) throw new Error(`No control labelled ${label}`);
  return (found.querySelector('input') ?? document.getElementById(found.htmlFor)) as T;
}
async function choose(label: string, value: string) {
  await act(async () => {
    const select = control<HTMLSelectElement>(label);
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function toggle(label: string) { await act(async () => control<HTMLInputElement>(label).click()); }
function tryButton() { return Array.from(container.querySelectorAll('button')).find(button => /Try a quip|Asking/.test(button.textContent ?? ''))!; }

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  update.mockClear();
  settings = { ...DEFAULT_PIP_SETTINGS, enabled: true };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('Settings → Pip', () => {
  it('waits for preferences before showing controls', async () => {
    settings = null;
    await render();
    expect(container.textContent).toContain('Loading Pip preferences');
    expect(container.querySelector('select')).toBeNull();
  });

  it('saves each presentation control as it changes', async () => {
    await render();
    await toggle('Show Pip in the sidebar');
    expect(update).toHaveBeenLastCalledWith({ enabled: false });
    await choose('Personality', 'sweet');
    expect(update).toHaveBeenLastCalledWith({ personality: 'sweet' });
    await toggle('Quiet');
    expect(update).toHaveBeenLastCalledWith({ quiet: true });
    await toggle('Ambient motion');
    expect(update).toHaveBeenLastCalledWith({ motion: false });
    await toggle('Operational nudges');
    expect(update).toHaveBeenLastCalledWith({ nudges: true });
  });

  it('keeps AI quips off by default, with limits and prompt consent locked until a backend is chosen', async () => {
    const backendStatus = vi.fn();
    vi.stubGlobal('electronAPI', { pip: { comment: vi.fn(), backendStatus } });
    await render();
    expect(control<HTMLSelectElement>('Backend').value).toBe('off');
    expect(backendStatus).not.toHaveBeenCalled();
    expect(control<HTMLSelectElement>('Quips per hour').disabled).toBe(true);
    expect(control<HTMLSelectElement>('Shortest gap between quips').disabled).toBe(true);
    expect(control<HTMLInputElement>('Share submitted prompts').disabled).toBe(true);
    expect(tryButton().disabled).toBe(true);
    await choose('Backend', 'codex');
    expect(update).toHaveBeenLastCalledWith({ aiComments: true, aiBackend: 'codex' });
  });

  it('checks the chosen backend and names the company that receives shared prompts', async () => {
    const backendStatus = vi.fn(async (backend: string) => backend === 'claude'
      ? { backend, ready: true, detail: 'Signed in with Claude Max. Quips use Claude Haiku.' }
      : { backend, ready: false, detail: 'Sign in to Codex with ChatGPT to enable AI quips.' });
    vi.stubGlobal('electronAPI', { pip: { comment: vi.fn(), backendStatus } });
    settings = { ...settings!, aiComments: true, aiBackend: 'codex' };
    await render();
    const status = () => container.querySelector<HTMLElement>('.pip-settings-status')!;
    expect(backendStatus).toHaveBeenLastCalledWith('codex');
    expect(status().textContent).toContain('Sign in to Codex');
    expect(status().dataset.ready).toBe('false');
    expect(container.textContent).toContain('to OpenAI');
    await choose('Backend', 'claude');
    expect(update).toHaveBeenLastCalledWith({ aiComments: true, aiBackend: 'claude' });
    settings = { ...settings, aiBackend: 'claude' };
    await render();
    expect(backendStatus).toHaveBeenLastCalledWith('claude');
    expect(status().textContent).toBe('Signed in with Claude Max. Quips use Claude Haiku.');
    expect(container.textContent).toContain('to Anthropic');
    await toggle('Share submitted prompts');
    expect(update).toHaveBeenLastCalledWith({ sharePrompts: true });
    await choose('Backend', 'off');
    expect(update).toHaveBeenLastCalledWith({ aiComments: false });
  });

  it('saves the hourly limit and gap, and lists a saved value that is not a preset', async () => {
    vi.stubGlobal('electronAPI', { pip: { comment: vi.fn(), backendStatus: vi.fn(() => new Promise(() => {})) } });
    settings = { ...settings!, aiComments: true, aiHourlyLimit: 9, aiCooldownSeconds: 90 };
    await render();
    const hourly = control<HTMLSelectElement>('Quips per hour');
    expect(hourly.value).toBe('9');
    expect(Array.from(hourly.options).map(option => option.value)).toEqual(['2', '4', '6', '9', '12', '20', '30']);
    expect(control<HTMLSelectElement>('Shortest gap between quips').selectedOptions[0].textContent).toBe('1.5 minutes');
    await choose('Quips per hour', '20');
    expect(update).toHaveBeenLastCalledWith({ aiHourlyLimit: 20 });
    await choose('Shortest gap between quips', '300');
    expect(update).toHaveBeenLastCalledWith({ aiCooldownSeconds: 300 });
  });

  it('asks for one quip on demand and shows the line or the reason', async () => {
    const comment = vi.fn()
      .mockResolvedValueOnce({ status: 'ready', line: 'Testing, testing.', model: 'claude-haiku-5-5', reason: null })
      .mockResolvedValueOnce({ status: 'paused', line: null, model: null, reason: 'Hourly limit reached. Local quips for now.' })
      .mockRejectedValueOnce(new Error('ipc down'));
    vi.stubGlobal('electronAPI', { pip: { comment, backendStatus: vi.fn(() => new Promise(() => {})) } });
    settings = { ...settings!, aiComments: true, aiBackend: 'claude' };
    await render();
    expect(container.querySelector('.pip-settings-status')?.textContent).toBe('Checking sign-in…');
    await act(async () => tryButton().click());
    expect(comment).toHaveBeenCalledWith({ event: 'hello', sessionId: null });
    expect(container.textContent).toContain('Pip: “Testing, testing.” (claude-haiku-5-5)');
    await act(async () => tryButton().click());
    expect(container.textContent).toContain('Hourly limit reached');
    await act(async () => tryButton().click());
    expect(container.textContent).toContain('Could not ask for a quip.');
  });

  it.each([
    [{ enabled: false }, 'Turn Pip on to try a quip.'],
    [{ collapsed: true }, 'Expand Pip in the sidebar to try a quip.'],
    [{ quiet: true }, 'Turn Quiet off to try a quip.'],
  ] as const)('explains why Try a quip is unavailable: %j', async (patch, reason) => {
    vi.stubGlobal('electronAPI', { pip: { comment: vi.fn(), backendStatus: vi.fn(() => new Promise(() => {})) } });
    settings = { ...settings!, aiComments: true, ...patch };
    await render();
    expect(tryButton().disabled).toBe(true);
    expect(container.textContent).toContain(reason);
  });

  it('locks every control while a save is in flight', async () => {
    vi.stubGlobal('electronAPI', { pip: { comment: vi.fn(), backendStatus: vi.fn(() => new Promise(() => {})) } });
    settings = { ...settings!, aiComments: true };
    await render(true);
    const controls = [...container.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input, select, button')];
    expect(controls.length).toBeGreaterThan(8);
    expect(controls.every(item => item.disabled)).toBe(true);
  });
});
