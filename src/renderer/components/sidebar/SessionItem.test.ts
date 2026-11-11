// @vitest-environment jsdom
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionInfo } from '../../../shared/types';
import { SessionItem } from './SessionItem';
import { change, click, createView } from '../visibility.test-helper';

type Props = React.ComponentProps<typeof SessionItem>;

let view: ReturnType<typeof createView>;
beforeEach(() => {
  view = createView();
  // The row abbreviates paths under the home directory.
  window.electronAPI = { homeDir: '/home/max', platform: 'linux' } as unknown as typeof window.electronAPI;
});
afterEach(async () => { vi.useRealTimers(); await view.dispose(); });

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 's1', label: 'api', workingDir: '/repo/tether', state: 'running', environmentId: 'env-1', cliTool: 'claude', ...overrides,
  } as SessionInfo;
}

function handlers() {
  return { onClick: vi.fn(), onStop: vi.fn(), onRename: vi.fn(), onRemove: vi.fn(), onDuplicate: vi.fn() };
}

async function render(props: Partial<Props> = {}) {
  const base = handlers();
  await view.render(React.createElement(SessionItem, { session: session(), isActive: false, ...base, ...props }));
  return base;
}

const row = () => view.container.querySelector<HTMLElement>('.session-item')!;
const dot = () => view.container.querySelector<HTMLElement>('.status-dot')!;
const menuButton = () => view.container.querySelector<HTMLElement>('.session-menu-button')!;
const menu = () => view.container.querySelector<HTMLElement>('[role="menu"]');
const menuLabels = () => [...view.container.querySelectorAll('[role="menuitem"]')].map(item => item.textContent?.trim());
const menuItem = (label: string) => [...view.container.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.trim() === label)!;
async function key(target: EventTarget, init: KeyboardEventInit) {
  await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })); });
}

describe('status dot', () => {
  it.each([
    [{ state: 'running' }, {}, 'running', 'Status: running', null],
    [{ state: 'starting' }, {}, 'running', 'Status: running', null],
    [{ state: 'waiting' }, { isVisibleInLayout: true }, 'waiting', 'Status: waiting for your input', null],
    [{ state: 'waiting', waitingReason: 'permission' }, { isVisibleInLayout: true }, 'waiting-permission', 'Status: waiting on a permission prompt', 'Waiting on a permission prompt — switch in to respond'],
    [{ state: 'waiting' }, { isVisibleInLayout: false }, 'waiting-permission', 'Status: waiting (not currently visible)', 'This session is waiting and not currently visible'],
    [{ state: 'waiting' }, { isVisibleInLayout: false, bangSuppressed: true }, 'waiting', 'Status: waiting for your input', null],
    [{ state: 'waiting', waitingReason: 'permission' }, { isVisibleInLayout: false, bangSuppressed: true }, 'waiting-permission', 'Status: waiting on a permission prompt', 'Waiting on a permission prompt — switch in to respond'],
    [{ state: 'idle' }, { isVisibleInLayout: false }, 'waiting-permission', 'Status: waiting (not currently visible)', 'This session is waiting and not currently visible'],
    [{ state: 'idle' }, { isVisibleInLayout: false, bangSuppressed: true }, 'idle', 'Status: idle', null],
    [{ state: 'stopped' }, {}, 'stopped', 'Status: stopped', null],
    [{ state: 'dead' }, {}, 'dead', 'Status: failed (exited with an error)', null],
  ] as Array<[Partial<SessionInfo>, Partial<Props>, string, string, string | null]>)(
    'shows %j %j as %s',
    async (sessionState, props, className, label, tooltip) => {
      await render({ session: session(sessionState), ...props });

      expect(dot().className).toBe(`status-dot status-dot--${className}`);
      expect(dot().getAttribute('aria-label')).toBe(label);
      expect(dot().getAttribute('title')).toBe(tooltip);
    },
  );
});

describe('row', () => {
  it('selects the session on click or Enter and marks the active one', async () => {
    const { onClick } = await render({ isActive: true });

    expect(row().className).toContain('session-item--active');
    expect(row().title).toBe('api\n/repo/tether');
    await click(row());
    await key(row(), { key: 'Enter' });
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('describes its state instead of repeating the path when nested under a repo group', async () => {
    const cases: Array<[Partial<SessionInfo>, string]> = [
      [{ state: 'waiting', waitingReason: 'permission' }, 'Needs permission'],
      [{ state: 'waiting' }, 'Waiting for you'],
      [{ state: 'dead' }, 'Failed'],
      [{ state: 'stopped' }, 'Stopped'],
      [{ state: 'starting' }, 'Starting'],
      [{ state: 'running' }, 'Running'],
      [{ state: 'idle' }, 'Idle'],
    ];
    for (const [state, expected] of cases) {
      await render({ session: session(state), nested: true });
      expect(view.container.querySelector('.session-path-text')?.textContent, JSON.stringify(state)).toBe(expected);
    }
    expect(row().className).toContain('session-item--nested');
  });

  it('marks resumed, Helm, dispatched and muted sessions', async () => {
    const titles = () => [...view.container.querySelectorAll('.session-label [title]')].map(item => item.getAttribute('title'));

    await render({ session: session({ resumed: true, helmEnabled: true }) });
    expect(titles()).toEqual([]);

    await render({
      session: session({ resumed: true, helmEnabled: true, parentSessionId: 'parent', notificationsMuted: true }),
      showResumeBadge: true, allowHelm: true,
    });
    expect(titles()).toEqual([
      'Resumed from a previous chat', 'Helm enabled — can dispatch child sessions',
      'Dispatched by another session via Helm', 'Notifications muted',
    ]);
  });

  it('focuses the pane showing the session without also selecting the row', async () => {
    const onFocusPane = vi.fn();
    const { onClick } = await render({
      paneLocation: { paneId: 'pane-2', shape: 'split-h', slotIndex: 1, totalSlots: 2 }, paneHidden: true, onFocusPane,
    });

    const badge = view.container.querySelector<HTMLElement>('.pane-location-badge')!;
    expect(badge.className).toContain('pane-location-badge--hidden');
    await click(badge);

    expect(onFocusPane).toHaveBeenCalledWith('pane-2');
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('actions menu', () => {
  it('offers only the actions that apply to the session', async () => {
    await render();
    await click(menuButton());
    expect(menuLabels()).toEqual(['Rename', 'Duplicate', 'Stop', 'Remove']);
    expect(menuButton().getAttribute('aria-expanded')).toBe('true');

    await render({
      session: session({ state: 'stopped', helmEnabled: true, notificationsMuted: true }),
      onResumePrevious: vi.fn(), onCliMaintenance: vi.fn(), allowHelm: true, onToggleHelm: vi.fn(), onToggleNotificationsMuted: vi.fn(),
    });
    expect(menuLabels()).toEqual([
      'Rename', 'Duplicate', 'Resume previous conversation...', 'Check / update CLI…', 'Disable Helm', 'Unmute notifications', 'Remove',
    ]);

    await render({ session: session({ cliTool: 'custom' }), onCliMaintenance: vi.fn() });
    expect(menuLabels()).not.toContain('Check / update CLI…');
  });

  it('runs the chosen action once and closes, without selecting the row', async () => {
    const onToggleHelm = vi.fn();
    const onToggleNotificationsMuted = vi.fn();
    const onResumePrevious = vi.fn();
    const onCliMaintenance = vi.fn();
    const base = await render({ onResumePrevious, onCliMaintenance, allowHelm: true, onToggleHelm, onToggleNotificationsMuted });

    for (const label of ['Duplicate', 'Resume previous conversation...', 'Check / update CLI…', 'Enable Helm', 'Mute notifications', 'Stop', 'Remove']) {
      await click(menuButton());
      await click(menuItem(label));
      expect(menu(), label).toBeNull();
    }

    expect(base.onDuplicate).toHaveBeenCalledOnce();
    expect(onResumePrevious).toHaveBeenCalledOnce();
    expect(onCliMaintenance).toHaveBeenCalledOnce();
    expect(onToggleHelm).toHaveBeenCalledExactlyOnceWith(true);
    expect(onToggleNotificationsMuted).toHaveBeenCalledExactlyOnceWith(true);
    expect(base.onStop).toHaveBeenCalledOnce();
    expect(base.onRemove).toHaveBeenCalledOnce();
    expect(base.onClick).not.toHaveBeenCalled();
  });

  it('opens from the keyboard or a right-click, moves with the arrows, and Escape returns focus to the row', async () => {
    const base = await render();

    await key(row(), { key: 'F10', shiftKey: true });
    expect(document.activeElement?.textContent?.trim()).toBe('Rename');
    await key(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement?.textContent?.trim()).toBe('Remove');
    await key(document.activeElement!, { key: 'ArrowDown' });
    await key(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent?.trim()).toBe('Duplicate');
    await key(document.activeElement!, { key: 'Enter' });
    expect(base.onDuplicate).toHaveBeenCalledOnce();

    await key(row(), { key: 'ContextMenu' });
    await key(document.activeElement!, { key: 'Escape' });
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(row());

    await act(async () => { row().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
    expect(menu()).not.toBeNull();
    await key(row(), { key: 'Escape' });
    expect(menu()).toBeNull();
    expect(base.onClick).not.toHaveBeenCalled();
  });

  it('closes when the user presses elsewhere, but not inside the menu or on its own button', async () => {
    await render();
    await click(menuButton());
    const press = (target: EventTarget) => act(async () => { target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });

    await press(menuItem('Rename'));
    await press(menuButton());
    expect(menu()).not.toBeNull();

    await press(document.body);
    expect(menu()).toBeNull();
  });
});

describe('rename', () => {
  const input = () => view.container.querySelector<HTMLInputElement>('.session-rename-input')!;
  async function startRename(props: Partial<Props> = {}) {
    const base = await render(props);
    await click(menuButton());
    await click(menuItem('Rename'));
    return base;
  }

  it('edits in place with the current label selected, and saves a trimmed name on Enter', async () => {
    const { onRename, onClick } = await startRename();

    expect(document.activeElement).toBe(input());
    expect(input().value).toBe('api');
    expect(view.container.querySelector('.session-menu-button')).toBeNull();

    await change(input(), '  api server  ');
    await click(input());
    await key(input(), { key: ' ' });
    expect(onClick).not.toHaveBeenCalled();
    await key(input(), { key: 'Enter' });

    expect(onRename).toHaveBeenCalledExactlyOnceWith('api server');
    expect(view.container.querySelector('.session-rename-input')).toBeNull();
  });

  it('keeps the old name when the edit is cancelled, blank or unchanged', async () => {
    const { onRename } = await startRename();
    await change(input(), 'discarded');
    await key(input(), { key: 'Escape' });
    expect(view.container.querySelector('.session-label')?.textContent).toBe('api');

    await click(menuButton());
    await click(menuItem('Rename'));
    expect(input().value).toBe('api');
    await change(input(), '   ');
    await act(async () => { input().dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });

    await click(menuButton());
    await click(menuItem('Rename'));
    await key(input(), { key: 'Enter' });

    expect(onRename).not.toHaveBeenCalled();
  });
});

describe('hover preview', () => {
  const popover = () => view.container.querySelector('.session-preview-popover');
  const hover = () => act(async () => { row().dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
  const leave = () => act(async () => { row().dispatchEvent(new MouseEvent('mouseout', { bubbles: true })); });
  const wait = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });

  beforeEach(() => { vi.useFakeTimers(); });

  it('shows recent terminal lines after a short hover and hides them on leave', async () => {
    const getPreviewLines = vi.fn(() => ['$ npm test', 'all passed']);
    await render({ getPreviewLines });

    await hover();
    await wait(200);
    expect(getPreviewLines).not.toHaveBeenCalled();
    await wait(200);
    expect(getPreviewLines).toHaveBeenCalledWith('s1');
    expect([...view.container.querySelectorAll('.session-preview-popover-line')].map(line => line.textContent)).toEqual(['$ npm test', 'all passed']);

    await leave();
    expect(popover()).toBeNull();
  });

  it('never asks for a preview after a quick pass, and shows nothing for an empty buffer', async () => {
    const getPreviewLines = vi.fn((): string[] => []);
    await render({ getPreviewLines });

    await hover();
    await wait(100);
    await leave();
    await wait(1000);
    expect(getPreviewLines).not.toHaveBeenCalled();

    await hover();
    await wait(400);
    expect(getPreviewLines).toHaveBeenCalledOnce();
    expect(popover()).toBeNull();
  });

  it('gets out of the way when the row is clicked or its menu opens', async () => {
    await render({ getPreviewLines: () => ['output'] });

    await hover();
    await wait(400);
    expect(popover()).not.toBeNull();
    await click(row());
    expect(popover()).toBeNull();

    await hover();
    await wait(400);
    await click(menuButton());
    expect(popover()).toBeNull();
  });

  it('does nothing on hover when previews are not provided', async () => {
    await render();
    await hover();
    await wait(1000);
    expect(popover()).toBeNull();
  });
});

describe('drag to reorder', () => {
  function transfer(data: Record<string, string> = {}) {
    const store = new Map(Object.entries(data));
    return {
      effectAllowed: '', dropEffect: '',
      get types() { return [...store.keys()]; },
      setData: (type: string, value: string) => { store.set(type, value); },
      getData: (type: string) => store.get(type) ?? '',
    };
  }
  async function drag(target: HTMLElement, type: string, dataTransfer: ReturnType<typeof transfer>, clientY = 0) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientY });
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
    await act(async () => { target.dispatchEvent(event); });
    return event;
  }

  /** Two rows: `source` is dragged, `target` receives. Rows are 40px tall, so y=10 is the top half. */
  async function renderPair(targetSession: Partial<SessionInfo>, targetProps: Partial<Props> = {}) {
    const onReorderDrop = vi.fn();
    const sourceHandlers = { onDragStart: vi.fn(), onDragEnd: vi.fn() };
    await view.render(React.createElement(React.Fragment, null,
      React.createElement(SessionItem, { key: 'a', session: session({ id: 'a', label: 'source' }), isActive: false, ...handlers(), ...sourceHandlers }),
      React.createElement(SessionItem, { key: 'b', session: session({ id: 'b', label: 'target', ...targetSession }), isActive: false, ...handlers(), onReorderDrop, ...targetProps }),
    ));
    const [source, target] = [...view.container.querySelectorAll<HTMLElement>('.session-item')];
    target.getBoundingClientRect = () => ({ top: 0, height: 40 }) as DOMRect;
    return { source, target, onReorderDrop, sourceHandlers };
  }

  it('shows where the row will land and reports the drop to the group', async () => {
    const { source, target, onReorderDrop, sourceHandlers } = await renderPair({});
    const data = transfer();

    await drag(source, 'dragstart', data);
    expect(sourceHandlers.onDragStart).toHaveBeenCalledWith('a');
    expect(data.getData('application/tether-session')).toBe('a');
    expect(data.effectAllowed).toBe('copyMove');

    const over = await drag(target, 'dragover', data, 10);
    expect(over.defaultPrevented).toBe(true);
    expect(target.className).toContain('session-item--drop-above');
    await drag(target, 'dragover', data, 30);
    expect(target.className).toContain('session-item--drop-below');
    await drag(target, 'dragleave', data);
    expect(target.className).not.toContain('session-item--drop');

    await drag(target, 'drop', data, 30);
    expect(onReorderDrop).toHaveBeenCalledExactlyOnceWith('a', 'b', 'below');

    await drag(source, 'dragend', data);
    expect(sourceHandlers.onDragEnd).toHaveBeenCalledOnce();
    await drag(target, 'drop', data, 10);
    expect(onReorderDrop).toHaveBeenCalledOnce();
  });

  it.each([
    ['another working directory', { workingDir: '/repo/other' }],
    ['another environment', { environmentId: 'env-2' }],
  ])('refuses a row from %s', async (_name, targetSession) => {
    const { source, target, onReorderDrop } = await renderPair(targetSession);
    const data = transfer();

    await drag(source, 'dragstart', data);
    const over = await drag(target, 'dragover', data, 10);
    await drag(target, 'drop', data, 10);

    expect(over.defaultPrevented).toBe(false);
    expect(target.className).not.toContain('session-item--drop');
    expect(onReorderDrop).not.toHaveBeenCalled();
    await drag(source, 'dragend', data);
  });

  it('ignores a pane drag that carries no reorder intent, and a drop without a source id', async () => {
    const { source, target, onReorderDrop } = await renderPair({});

    await drag(source, 'dragstart', transfer());
    const over = await drag(target, 'dragover', transfer({ 'application/tether-session': 'a' }), 10);
    expect(over.defaultPrevented).toBe(false);

    await drag(target, 'drop', transfer(), 10);
    expect(onReorderDrop).not.toHaveBeenCalled();
    await drag(source, 'dragend', transfer());
  });
});
