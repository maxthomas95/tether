// @vitest-environment jsdom
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeybindingsEditor } from './KeybindingsEditor';
import { MenuBar, type MenuDef } from './MenuBar';
import { ResumeChatDialog } from './sidebar/ResumeChatDialog';
import { DEFAULT_KEYBINDINGS, type Chord, type KeybindingAction } from '../../shared/keybindings';
import type { TranscriptInfo } from '../../shared/types';
import { button, change, click, createView, deferred } from './visibility.test-helper';

let view: ReturnType<typeof createView>;
beforeEach(() => { view = createView(); });
afterEach(async () => { vi.useRealTimers(); await view.dispose(); });

async function key(target: EventTarget, init: KeyboardEventInit) {
  await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })); });
}

describe('MenuBar', () => {
  function setup(overrides: Partial<React.ComponentProps<typeof MenuBar>> = {}) {
    const actions = { newSession: vi.fn(), stop: vi.fn(), toggle: vi.fn() };
    const menus: MenuDef[] = [
      { label: 'File', items: [
        { label: 'New session', shortcut: 'Ctrl+N', onClick: actions.newSession },
        { separator: true },
        { label: 'Stop session', onClick: actions.stop, disabled: true, danger: true },
      ] },
      { label: 'View', items: [{ label: 'Sidebar', checked: true, onClick: actions.toggle }] },
    ];
    const props = { menus, onSearch: vi.fn(), searchShortcut: 'Ctrl+P', paneLimit: 2 as number | 'canvas', onPaneLimitChange: vi.fn(), ...overrides };
    return { actions, props, element: React.createElement(MenuBar, props) };
  }
  const items = () => [...view.container.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  const item = (label: string) => items().find(entry => entry.querySelector('.menubar-dropdown-label')?.textContent === label)!;
  const openMenu = () => view.container.querySelector('[role="menu"]')?.getAttribute('aria-label') ?? null;

  it('opens one menu at a time and runs the chosen item', async () => {
    const { actions, element } = setup();
    await view.render(element);
    expect(openMenu()).toBeNull();

    await click(button(view.container, 'File'));
    expect(openMenu()).toBe('File');
    expect(button(view.container, 'File').getAttribute('aria-expanded')).toBe('true');
    expect(item('New session').textContent).toContain('Ctrl+N');
    expect(view.container.querySelectorAll('.menubar-dropdown-sep')).toHaveLength(1);

    await click(item('New session'));
    expect(actions.newSession).toHaveBeenCalledOnce();
    expect(openMenu()).toBeNull();
  });

  it('leaves a disabled item inert and out of the tab order', async () => {
    const { actions, element } = setup();
    await view.render(element);
    await click(button(view.container, 'File'));

    const stop = item('Stop session');
    expect(stop.tabIndex).toBe(-1);
    expect(stop.className).toContain('menubar-dropdown-item--danger');
    await click(stop);
    await key(stop, { key: 'Enter' });

    expect(actions.stop).not.toHaveBeenCalled();
    expect(openMenu()).toBe('File');
  });

  it('follows the pointer between menus only while one is open, and activates items from the keyboard', async () => {
    const { actions, element } = setup();
    await view.render(element);
    const viewMenu = button(view.container, 'View').parentElement!;
    const hover = () => act(async () => { viewMenu.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });

    await hover();
    expect(openMenu()).toBeNull();

    await click(button(view.container, 'File'));
    await hover();
    expect(openMenu()).toBe('View');
    expect(item('Sidebar').querySelector('.menubar-dropdown-check')?.textContent).toBe('✓');

    await key(item('Sidebar'), { key: ' ' });
    expect(actions.toggle).toHaveBeenCalledOnce();
  });

  it('closes on a second click, Escape, or a press outside the bar', async () => {
    const { element } = setup();
    await view.render(element);
    const file = button(view.container, 'File');

    await click(file);
    await click(file);
    expect(openMenu()).toBeNull();

    await click(file);
    await key(window, { key: 'Escape' });
    expect(openMenu()).toBeNull();

    await click(file);
    await act(async () => { file.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(openMenu()).toBe('File');
    await act(async () => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(openMenu()).toBeNull();
  });

  it('changes the layout limit and opens search, closing any open menu', async () => {
    const { props, element } = setup();
    await view.render(element);
    const layout = view.container.querySelector<HTMLSelectElement>('select')!;
    expect(layout.value).toBe('2');

    await change(layout, '4');
    await change(layout, 'canvas');
    expect(props.onPaneLimitChange.mock.calls).toEqual([[4], ['canvas']]);

    await click(button(view.container, 'File'));
    const search = view.container.querySelector<HTMLButtonElement>('.menubar-search')!;
    expect(search.title).toBe('Find session (Ctrl+P)');
    await click(search);
    expect(props.onSearch).toHaveBeenCalledOnce();
    expect(openMenu()).toBeNull();
  });

  it('locks the layout choice until the workspace is ready and omits an unbound search shortcut', async () => {
    const { element } = setup({ layoutReady: false, searchShortcut: '', paneLimit: 'canvas' });
    await view.render(element);

    expect(view.container.querySelector<HTMLSelectElement>('select')!.disabled).toBe(true);
    expect(view.container.querySelector<HTMLButtonElement>('.menubar-search')!.title).toBe('Find session');
    expect(view.container.querySelector('kbd')).toBeNull();
  });
});

describe('KeybindingsEditor', () => {
  type Bindings = Record<KeybindingAction, Chord | null>;
  const row = (label: string) => [...view.container.querySelectorAll('tr')]
    .find(entry => entry.querySelector('.shortcuts-action')?.textContent === label)!;
  const rowButton = (label: string, name: string) => [...row(label).querySelectorAll('button')].find(entry => entry.textContent === name);

  async function render(overrides: Partial<Bindings> = {}) {
    const onChange = vi.fn();
    const bindings: Bindings = { ...DEFAULT_KEYBINDINGS, ...overrides };
    await view.render(React.createElement(KeybindingsEditor, { bindings, onChange }));
    return onChange;
  }

  it('lists every action under its group with the current chord', async () => {
    await render();

    expect(view.container.querySelectorAll('.shortcuts-group-header').length).toBeGreaterThan(1);
    expect(view.container.querySelectorAll('.shortcuts-action')).toHaveLength(Object.keys(DEFAULT_KEYBINDINGS).length);
    expect(row('New session').querySelector('kbd')?.textContent).toBe('Ctrl+N');
    expect(rowButton('New session', 'Reset')).toBeUndefined();
  });

  it('records the next real chord, ignoring bare modifiers and plain typing', async () => {
    const onChange = await render();
    await click(rowButton('New session', 'Record')!);
    expect(row('New session').textContent).toContain('Press a key…');

    await key(globalThis, { key: 'Control', ctrlKey: true });
    await key(globalThis, { key: 'k' });
    expect(onChange).not.toHaveBeenCalled();

    await key(globalThis, { key: 'K', ctrlKey: true, shiftKey: true });
    expect(onChange).toHaveBeenCalledExactlyOnceWith('session.new', 'ctrl+shift+k');
    expect(rowButton('New session', 'Record')).toBeDefined();

    await key(globalThis, { key: 'j', ctrlKey: true });
    expect(onChange).toHaveBeenCalledOnce();
  });

  it('cancels recording with Escape or the Cancel button without changing the binding', async () => {
    const onChange = await render();

    await click(rowButton('New session', 'Record')!);
    await key(globalThis, { key: 'Escape' });
    expect(rowButton('New session', 'Record')).toBeDefined();

    await click(rowButton('New session', 'Record')!);
    await click(rowButton('New session', 'Cancel')!);
    expect(row('New session').querySelector('kbd')?.textContent).toBe('Ctrl+N');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('unbinds a shortcut and offers a reset for anything changed from its default', async () => {
    const onChange = await render({ 'sidebar.toggle': null });

    await click(rowButton('New session', 'Unbind')!);
    expect(onChange).toHaveBeenLastCalledWith('session.new', null);

    expect(row('Toggle sidebar').textContent).toContain('— unbound —');
    expect(rowButton('Toggle sidebar', 'Unbind')).toBeUndefined();
    await click(rowButton('Toggle sidebar', 'Reset')!);
    expect(onChange).toHaveBeenLastCalledWith('sidebar.toggle', DEFAULT_KEYBINDINGS['sidebar.toggle']);
  });

  it('flags chords shared by two actions and chords the terminal needs', async () => {
    await render({ 'sidebar.toggle': 'ctrl+n', 'settings.open': 'ctrl+c' });

    expect(row('New session').querySelector('.shortcut-conflict')?.textContent).toBe('Conflicts with: Toggle sidebar');
    expect(row('Toggle sidebar').querySelector('.shortcut-conflict')?.textContent).toBe('Conflicts with: New session');
    expect(row('Open settings').querySelector('.shortcut-reserved')?.getAttribute('aria-label')).toBe('Reserved: Terminal interrupt (SIGINT)');
    expect(row('Find session').querySelector('.shortcut-conflict')).toBeNull();
  });
});

describe('ResumeChatDialog', () => {
  const NOW = new Date('2026-03-10T12:00:00Z');
  const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
  const transcripts: TranscriptInfo[] = [
    { id: 'current-id', mtime: ago(30_000), preview: 'Fix the flaky test' },
    { id: 'older-id', mtime: ago(5 * 60_000), preview: '' },
    { id: 'hours-id', mtime: ago(3 * 3_600_000), preview: 'Refactor the reducer' },
    { id: 'days-id', mtime: ago(4 * 86_400_000), preview: 'Write docs' },
    { id: 'ancient-id', mtime: ago(90 * 86_400_000), preview: 'Initial spike' },
    { id: 'future-id', mtime: 'not-a-date', preview: 'Clock skew' },
  ];
  const rows = () => [...view.container.querySelectorAll<HTMLElement>('.transcript-row')];
  const rowFor = (id: string) => rows().find(entry => entry.textContent?.includes(id))!;

  function stubTranscripts(list: () => Promise<TranscriptInfo[]>) {
    const spy = vi.fn(list);
    window.electronAPI = { transcripts: { list: spy } } as unknown as typeof window.electronAPI;
    return spy;
  }
  function dialog(overrides: Partial<React.ComponentProps<typeof ResumeChatDialog>> = {}) {
    const handlers = { onClose: vi.fn(), onPick: vi.fn() };
    const element = React.createElement(ResumeChatDialog, {
      isOpen: true, workingDir: '/repo/tether', cliTool: 'codex', currentTranscriptId: 'current-id', ...handlers, ...overrides,
    });
    return { handlers, element };
  }

  beforeEach(() => { vi.useFakeTimers({ now: NOW, toFake: ['Date'] }); });

  it('does not query transcripts while closed', async () => {
    const list = stubTranscripts(async () => transcripts);
    await view.render(dialog({ isOpen: false }).element);
    expect(list).not.toHaveBeenCalled();
    expect(view.container.innerHTML).toBe('');
  });

  it('lists conversations for the directory and tool with their age', async () => {
    const pending = deferred<TranscriptInfo[]>();
    const list = stubTranscripts(() => pending.promise);
    await view.render(dialog().element);

    expect(list).toHaveBeenCalledWith('/repo/tether', 'codex');
    expect(view.container.textContent).toContain('Loading…');
    expect(view.container.textContent).toContain('Recent Codex CLI conversations');

    await act(async () => pending.resolve(transcripts));
    expect(view.container.textContent).not.toContain('Loading…');
    expect(rows().map(entry => entry.querySelector('.form-hint')?.textContent)).toEqual([
      '30s ago · current', '5m ago', '3h ago', '4d ago', new Date(transcripts[4].mtime).toLocaleDateString(), 'not-a-date',
    ]);
    expect(rowFor('older-id').textContent).toContain('(no user prompt yet)');
  });

  it('resumes the picked conversation by mouse or keyboard, but never the one already open', async () => {
    stubTranscripts(async () => transcripts);
    const { handlers, element } = dialog();
    await view.render(element);

    await click(rowFor('current-id'));
    await key(rowFor('current-id'), { key: 'Enter' });
    expect(rowFor('current-id').tabIndex).toBe(-1);
    expect(handlers.onPick).not.toHaveBeenCalled();

    await click(rowFor('hours-id'));
    await key(rowFor('days-id'), { key: ' ' });
    await key(rowFor('days-id'), { key: 'Tab' });
    expect(handlers.onPick.mock.calls).toEqual([['hours-id'], ['days-id']]);
    expect(handlers.onClose).toHaveBeenCalledTimes(2);
  });

  it('highlights only rows that can be picked', async () => {
    stubTranscripts(async () => transcripts);
    await view.render(dialog().element);
    const over = (element: HTMLElement) => act(async () => { element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
    const out = (element: HTMLElement) => act(async () => { element.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })); });

    await over(rowFor('current-id'));
    expect(rowFor('current-id').style.background).toBe('');
    await over(rowFor('hours-id'));
    expect(rowFor('hours-id').style.background).not.toBe('');
    await out(rowFor('hours-id'));
    expect(rowFor('hours-id').style.background).toBe('');
  });

  it('explains an empty directory and a failed lookup', async () => {
    stubTranscripts(async () => []);
    await view.render(dialog().element);
    expect(view.container.textContent).toContain('No previous conversations found');

    stubTranscripts(async () => { throw new Error('history unreadable'); });
    await view.render(dialog({ workingDir: '/repo/other' }).element);
    expect(view.container.textContent).toContain('history unreadable');
    expect(view.container.textContent).not.toContain('No previous conversations found');
  });

  it('closes from Cancel, the backdrop and Escape', async () => {
    stubTranscripts(async () => []);
    const { handlers, element } = dialog();
    await view.render(element);

    await click(button(view.container, 'Cancel'));
    await click(view.container.querySelector<HTMLElement>('.dialog-overlay')!);
    await click(view.container.querySelector<HTMLElement>('.dialog')!);
    expect(handlers.onClose).toHaveBeenCalledTimes(2);

    await key(document, { key: 'Escape' });
    expect(handlers.onClose).toHaveBeenCalledTimes(3);
  });
});
