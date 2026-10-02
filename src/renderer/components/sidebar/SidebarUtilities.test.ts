// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SidebarUtilities } from './SidebarUtilities';

let container: HTMLDivElement;
let root: Root;
const onOpenSettings = vi.fn();
const onJumpToNextWaiting = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function render(waitingCount: number, nextWaitingShortcut = 'Ctrl+Shift+A') {
  act(() => root.render(createElement(SidebarUtilities, {
    waitingCount, nextWaitingShortcut, onOpenSettings, onJumpToNextWaiting,
  })));
}

describe('sidebar utilities', () => {
  it('keeps Settings available when the attention queue is empty', () => {
    render(0);
    expect(container.querySelector('.attention-queue-pill')).toBeNull();

    const settings = container.querySelector<HTMLButtonElement>('.sidebar-settings')!;
    expect(settings.textContent?.trim()).toBe('Settings');
    act(() => settings.click());
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(onJumpToNextWaiting).not.toHaveBeenCalled();
  });

  it('jumps to waiting sessions without opening Settings', () => {
    render(1);
    const pill = container.querySelector<HTMLButtonElement>('.attention-queue-pill')!;
    expect(pill.getAttribute('aria-label')).toBe('1 session waiting — jump to next');
    expect(pill.textContent?.trim()).toBe('1 waiting');
    expect(pill.title).toBe('Jump to next waiting session (Ctrl+Shift+A)');
    expect(pill.querySelector('.status-dot')?.getAttribute('aria-hidden')).toBe('true');

    act(() => pill.click());
    expect(onJumpToNextWaiting).toHaveBeenCalledOnce();
    expect(onOpenSettings).not.toHaveBeenCalled();
  });

  it('updates counts while preserving Settings focus and the utilities row', () => {
    render(0);
    const row = container.querySelector('.sidebar-utilities');
    const settings = container.querySelector<HTMLButtonElement>('.sidebar-settings')!;
    settings.focus();

    for (const count of [1, 23, 123456789, 0]) {
      render(count);
      expect(container.querySelector('.sidebar-utilities')).toBe(row);
      expect(container.querySelector('.sidebar-settings')).toBe(settings);
      expect(document.activeElement).toBe(settings);
      const pill = container.querySelector('.attention-queue-pill');
      if (count) {
        expect(pill?.getAttribute('aria-label')).toBe(`${count} session${count === 1 ? '' : 's'} waiting — jump to next`);
        expect(pill?.querySelector('.attention-queue-label')?.textContent).toBe(`${count} waiting`);
      } else {
        expect(pill).toBeNull();
      }
    }
  });

  it('shows the remapped shortcut and removes it when the shortcut is disabled', () => {
    render(2, 'Alt+A');
    const pill = container.querySelector<HTMLButtonElement>('.attention-queue-pill')!;
    expect(pill.title).toBe('Jump to next waiting session (Alt+A)');
    expect(pill.getAttribute('aria-label')).toBe('2 sessions waiting — jump to next');

    render(2, '');
    expect(pill.title).toBe('Jump to next waiting session');
    act(() => pill.click());
    expect(onJumpToNextWaiting).toHaveBeenCalledOnce();
  });
});
