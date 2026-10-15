// @vitest-environment jsdom
import React, { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LocalThemeControls } from './LocalThemeControls';
import { button, click, createView } from './visibility.test-helper';

let view: ReturnType<typeof createView>;
beforeEach(() => { view = createView(); });
afterEach(async () => view.dispose());

it('opens the local folder, reloads themes, and identifies files that could not be loaded', async () => {
  const openFolder = vi.fn().mockResolvedValue(undefined);
  window.electronAPI = { themes: { openFolder } } as unknown as typeof window.electronAPI;
  const onReload = vi.fn().mockResolvedValue(undefined);
  await view.render(React.createElement(LocalThemeControls, {
    catalog: { directory: '/private/themes', themes: [], issues: [{ file: 'broken/theme.json', message: 'Missing color.' }] },
    onReload, disabled: false,
  }));
  expect(view.container.textContent).toContain('/private/themes');
  expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('broken/theme.json: Missing color.');
  await click(button(view.container, 'Open themes folder'));
  expect(openFolder).toHaveBeenCalledOnce();
  await click(button(view.container, 'Reload themes'));
  expect(onReload).toHaveBeenCalledOnce();
  expect(view.container.querySelector('[role="status"]')?.textContent).toBe('Themes reloaded.');
});

it('disables repeated actions while loading and reports reload failures', async () => {
  let reject!: (error: Error) => void;
  const onReload = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  await view.render(React.createElement(LocalThemeControls, { catalog: { directory: '', themes: [], issues: [] }, onReload, disabled: false }));
  await click(button(view.container, 'Reload themes'));
  expect(Array.from(view.container.querySelectorAll('button')).every(item => item.disabled)).toBe(true);
  await act(async () => reject(new Error('Cannot read themes.')));
  expect(view.container.querySelector('[role="alert"]')?.textContent).toBe('Cannot read themes.');
  expect(button(view.container, 'Reload themes').disabled).toBe(false);
});
