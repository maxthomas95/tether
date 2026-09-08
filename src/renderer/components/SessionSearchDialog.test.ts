// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { SessionInfo } from '../../shared/types';
import { SessionSearchDialog } from './SessionSearchDialog';

it('hands focus to a selected session but restores the opener when cancelled', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('electronAPI', { homeDir: '/home/demo' });
  const scrollDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} });
  const opener = document.createElement('button');
  const destination = document.createElement('textarea');
  document.body.append(opener, destination);
  const openerFocus = vi.spyOn(opener, 'focus');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let open!: () => void;
  function Harness() {
    const [isOpen, setOpen] = useState(false);
    open = () => setOpen(true);
    return createElement(SessionSearchDialog, {
      isOpen, sessions: [{ id: 'b', label: 'Backend', workingDir: '/repo', cliTool: 'claude', state: 'running' } as SessionInfo],
      environments: [], onClose: () => setOpen(false), onActivate: () => destination.focus(),
    });
  }
  try {
    await act(async () => root.render(createElement(Harness)));
    opener.focus();
    await act(async () => open());
    openerFocus.mockClear();
    await act(async () => container.querySelector<HTMLElement>('[role="option"]')!.click());
    expect(document.activeElement).toBe(destination);
    expect(openerFocus).not.toHaveBeenCalled();

    opener.focus();
    await act(async () => open());
    await act(async () => container.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.activeElement).toBe(opener);
  } finally {
    await act(async () => root.unmount());
    container.remove(); opener.remove(); destination.remove();
    if (scrollDescriptor) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollDescriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    vi.unstubAllGlobals();
  }
});
