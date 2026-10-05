// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { VaultStatusPill } from './VaultStatusPill';
import type { VaultStatus } from '../../../shared/types';

it('ignores a pending Vault failure after unmount and removes the listener', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let reject!: (error: Error) => void;
  const unsubscribe = vi.fn();
  vi.stubGlobal('electronAPI', { vault: {
    status: () => new Promise((_resolve, fail) => { reject = fail; }), onStatusChange: () => unsubscribe,
  } });
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(React.createElement(VaultStatusPill)));
    await act(async () => root.unmount());
    await act(async () => reject(new Error('late Vault failure')));
    expect(unsubscribe).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllGlobals();
  }
});

it('handles an unavailable initial status and accepts later status events', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let update!: (status: VaultStatus) => void;
  vi.stubGlobal('electronAPI', { vault: {
    status: vi.fn().mockRejectedValue(new Error('unavailable')),
    onStatusChange: (listener: typeof update) => { update = listener; return () => {}; },
  } });
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(React.createElement(VaultStatusPill)));
    expect(container.textContent).toBe('');
    await act(async () => update({ enabled: true, loggedIn: false, identity: null, expiresAt: null, lastError: null }));
    expect(container.textContent).toContain('Log in to Vault');
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

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
