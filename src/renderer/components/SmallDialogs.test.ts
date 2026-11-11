// @vitest-environment jsdom
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AboutDialog } from './AboutDialog';
import { ConfirmDialog, useConfirmDialog, type ConfirmOptions } from './ConfirmDialog';
import { Notifications, useNotifications, type NotifyOptions } from './Notifications';
import { VaultLoginPromptDialog } from './VaultLoginPromptDialog';
import { button, click, createView, deferred } from './visibility.test-helper';

let view: ReturnType<typeof createView>;
beforeEach(() => { view = createView(); });
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await view.dispose();
});

const text = () => view.container.textContent ?? '';
const overlay = () => view.container.querySelector<HTMLElement>('.dialog-overlay')!;
async function pressEscape() {
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
}

describe('ConfirmDialog', () => {
  const base = { isOpen: true, title: 'Remove session?', message: 'This stops the CLI.' };

  it('renders nothing while closed', async () => {
    await view.render(React.createElement(ConfirmDialog, { ...base, isOpen: false, onConfirm: vi.fn(), onCancel: vi.fn() }));
    expect(view.container.innerHTML).toBe('');
  });

  it('confirms with the checkbox state the user left', async () => {
    const onConfirm = vi.fn();
    await view.render(React.createElement(ConfirmDialog, {
      ...base, confirmLabel: 'Remove', danger: true, onConfirm, onCancel: vi.fn(),
      checkbox: { label: 'Also delete the worktree', hint: 'Uncommitted changes are lost.', defaultChecked: true },
    }));

    expect(text()).toContain('Uncommitted changes are lost.');
    expect(button(view.container, 'Remove').className).toContain('form-btn--danger');
    await click(view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    await click(button(view.container, 'Remove'));

    expect(onConfirm).toHaveBeenCalledWith(false);
  });

  it('cancels from the button, the close control, Escape and the backdrop, but not from inside the dialog', async () => {
    const onCancel = vi.fn();
    await view.render(React.createElement(ConfirmDialog, { ...base, onConfirm: vi.fn(), onCancel }));

    await click(view.container.querySelector<HTMLElement>('.dialog')!);
    expect(onCancel).not.toHaveBeenCalled();

    await click(button(view.container, 'Cancel'));
    await click(view.container.querySelector<HTMLElement>('.dialog-close')!);
    await pressEscape();
    await click(overlay());
    expect(onCancel).toHaveBeenCalledTimes(4);
    expect(button(view.container, 'OK').className).toContain('form-btn--primary');
  });
});

describe('useConfirmDialog', () => {
  let ask!: (options: ConfirmOptions) => Promise<{ confirmed: boolean; checkboxValue: boolean }>;
  function Host() {
    const { confirm, dialogProps } = useConfirmDialog();
    ask = confirm;
    return React.createElement(ConfirmDialog, dialogProps);
  }

  it('resolves with the answer and closes the dialog', async () => {
    await view.render(React.createElement(Host));
    expect(view.container.innerHTML).toBe('');

    let answer!: ReturnType<typeof ask>;
    await act(async () => { answer = ask({ title: 'Quit?', message: 'Sessions are running.', checkbox: { label: "Don't ask again" } }); });
    await click(view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    await click(button(view.container, 'OK'));

    await expect(answer).resolves.toEqual({ confirmed: true, checkboxValue: true });
    expect(view.container.innerHTML).toBe('');
  });

  it('resolves as declined, ignoring the checkbox, when cancelled', async () => {
    await view.render(React.createElement(Host));
    let answer!: ReturnType<typeof ask>;
    await act(async () => { answer = ask({ title: 'Quit?', message: '', cancelLabel: 'Stay', checkbox: { label: 'Remember', defaultChecked: true } }); });
    await click(button(view.container, 'Stay'));

    await expect(answer).resolves.toEqual({ confirmed: false, checkboxValue: false });
  });
});

describe('VaultLoginPromptDialog', () => {
  function stubVault(login: () => Promise<{ loggedIn: boolean }>) {
    const cancelLogin = vi.fn().mockResolvedValue(undefined);
    window.electronAPI = { vault: { login, cancelLogin } } as unknown as typeof window.electronAPI;
    return cancelLogin;
  }
  const open = (props: Partial<React.ComponentProps<typeof VaultLoginPromptDialog>> = {}) => {
    const handlers = { onLoginSuccess: vi.fn(), onCancel: vi.fn() };
    return { handlers, element: React.createElement(VaultLoginPromptDialog, { isOpen: true, ...handlers, ...props }) };
  };

  it('names the reference that needs Vault and continues after a successful login', async () => {
    stubVault(async () => ({ loggedIn: true }));
    const { handlers, element } = open({ reason: 'env var API_KEY' });
    await view.render(element);

    expect(text()).toContain('(env var API_KEY)');
    await click(button(view.container, 'Log In'));

    expect(handlers.onLoginSuccess).toHaveBeenCalledOnce();
    expect(handlers.onCancel).not.toHaveBeenCalled();
  });

  it('stays open with an explanation when login does not complete or fails', async () => {
    const login = vi.fn().mockResolvedValueOnce({ loggedIn: false }).mockRejectedValueOnce(new Error('Vault is sealed'));
    stubVault(login);
    const { handlers, element } = open();
    await view.render(element);

    await click(button(view.container, 'Log In'));
    expect(text()).toContain('Login did not complete');
    await click(button(view.container, 'Log In'));
    expect(text()).toContain('Vault is sealed');
    expect(handlers.onLoginSuccess).not.toHaveBeenCalled();
    expect(button(view.container, 'Log In').disabled).toBe(false);
  });

  it('aborts an in-flight browser login when cancelled, and starts fresh when reopened', async () => {
    const pending = deferred<{ loggedIn: boolean }>();
    const cancelLogin = stubVault(() => pending.promise);
    const { handlers, element } = open();
    await view.render(element);

    await click(button(view.container, 'Log In'));
    expect(button(view.container, 'Opening browser…').disabled).toBe(true);
    await pressEscape();
    expect(cancelLogin).toHaveBeenCalledOnce();
    expect(handlers.onCancel).toHaveBeenCalledOnce();

    await view.render(React.createElement(VaultLoginPromptDialog, { isOpen: false, ...handlers }));
    expect(view.container.innerHTML).toBe('');
    await view.render(element);
    expect(button(view.container, 'Log In').disabled).toBe(false);
  });

  it('does not cancel a login that was never started', async () => {
    const cancelLogin = stubVault(async () => ({ loggedIn: true }));
    const { handlers, element } = open();
    await view.render(element);

    await click(overlay());
    expect(handlers.onCancel).toHaveBeenCalledOnce();
    expect(cancelLogin).not.toHaveBeenCalled();
  });
});

describe('AboutDialog', () => {
  function stubExport(exportDiagnostics: () => Promise<{ ok: boolean; path?: string; error?: string }>) {
    vi.stubGlobal('__APP_VERSION__', '1.2.3');
    window.electronAPI = { diagnostics: { export: exportDiagnostics } } as unknown as typeof window.electronAPI;
  }
  const exportButton = () => button(view.container, 'Export diagnostics for support');

  it('shows the running version and closes on request', async () => {
    stubExport(vi.fn());
    const onClose = vi.fn();
    await view.render(React.createElement(AboutDialog, { isOpen: true, onClose }));

    expect(text()).toContain('Version 1.2.3');
    await click(button(view.container, 'Close'));
    await click(overlay());
    expect(onClose).toHaveBeenCalledTimes(2);

    await view.render(React.createElement(AboutDialog, { isOpen: false, onClose }));
    expect(view.container.innerHTML).toBe('');
  });

  it('reports where the diagnostics bundle was saved', async () => {
    const pending = deferred<{ ok: boolean; path?: string }>();
    stubExport(() => pending.promise);
    await view.render(React.createElement(AboutDialog, { isOpen: true, onClose: vi.fn() }));

    await click(exportButton());
    expect(button(view.container, 'Exporting…').disabled).toBe(true);
    await act(async () => pending.resolve({ ok: true, path: '/tmp/tether-diagnostics.zip' }));
    expect(text()).toContain('Saved to /tmp/tether-diagnostics.zip');
  });

  it.each([
    ['a cancelled save dialog', async () => ({ ok: false, error: 'cancelled' }), 'Bundles logs'],
    ['a write failure', async () => ({ ok: false, error: 'disk full' }), 'Export failed: disk full'],
    ['a failure without detail', async () => ({ ok: false }), 'Export failed: Unknown error'],
    ['a rejected request', async () => { throw new Error('IPC closed'); }, 'Export failed: IPC closed'],
  ])('handles %s', async (_name, exportDiagnostics, expected) => {
    stubExport(exportDiagnostics);
    await view.render(React.createElement(AboutDialog, { isOpen: true, onClose: vi.fn() }));

    await click(exportButton());

    expect(text()).toContain(expected);
    expect(exportButton().disabled).toBe(false);
  });
});

describe('notifications', () => {
  let api!: ReturnType<typeof useNotifications>;
  function Host() {
    api = useNotifications();
    return React.createElement(Notifications, { notifications: api.notifications, onDismiss: api.dismiss });
  }
  const titles = () => [...view.container.querySelectorAll('.notification-title')].map(item => item.textContent);
  async function notify(options: NotifyOptions) {
    await act(async () => { api.notify(options); });
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    await view.render(React.createElement(Host));
  });

  it('announces errors as alerts and lets any toast be dismissed early', async () => {
    await notify({ type: 'error', title: 'Failed to create session', message: 'ssh: connection refused' });
    await notify({ title: 'Update available' });

    const [error, info] = view.container.querySelectorAll('.notification');
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.textContent).toContain('ssh: connection refused');
    expect(info.getAttribute('role')).toBeNull();
    expect(info.className).toContain('notification--info');

    await click(error.querySelector<HTMLElement>('.notification-close')!);
    expect(titles()).toEqual(['Update available']);
  });

  it('keeps errors on screen longer than information', async () => {
    await notify({ type: 'error', title: 'Error' });
    await notify({ type: 'success', title: 'Saved' });

    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(titles()).toEqual(['Error']);
    await act(async () => { vi.advanceTimersByTime(7000); });
    expect(titles()).toEqual([]);
  });

  it('gives a toast with an action time to be used, and honours an explicit lifetime', async () => {
    const onClick = vi.fn();
    await notify({ title: 'Update ready', action: { label: 'Restart', onClick } });
    await notify({ title: 'Brief', ttl: 1000 });

    await act(async () => { vi.advanceTimersByTime(12_000); });
    expect(titles()).toEqual(['Update ready']);
    await click(button(view.container, 'Restart'));
    expect(onClick).toHaveBeenCalledOnce();
    await act(async () => { vi.advanceTimersByTime(8000); });
    expect(titles()).toEqual([]);
  });

  it('shows only the five most recent toasts', async () => {
    for (let index = 1; index <= 7; index++) await notify({ title: `Toast ${index}` });
    expect(titles()).toEqual(['Toast 3', 'Toast 4', 'Toast 5', 'Toast 6', 'Toast 7']);
  });
});
