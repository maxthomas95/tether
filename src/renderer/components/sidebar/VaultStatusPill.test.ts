// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { VaultStatusPill } from './VaultStatusPill';

it('lets an abandoned browser login be cancelled and retried', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let rejectLogin: (error: Error) => void = () => {};
  const login = vi.fn(() => new Promise<never>((_resolve, reject) => { rejectLogin = reject; }));
  const cancelLogin = vi.fn(async () => { rejectLogin(new Error('Vault login cancelled')); });
  vi.stubGlobal('electronAPI', {
    vault: {
      status: async () => ({ enabled: true, loggedIn: false }),
      onStatusChange: () => () => {},
      login,
      cancelLogin,
    },
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(React.createElement(VaultStatusPill)));
    const click = async () => act(async () => {
      container.querySelector<HTMLElement>('[role="button"]')!.click();
    });
    await click();
    expect(container.textContent).toContain('Cancel Vault login');
    await click();
    expect(cancelLogin).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('Log in to Vault');
    await click();
    expect(login).toHaveBeenCalledTimes(2);
    await click();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
