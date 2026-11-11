// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatExpiry, VaultLoginControls } from './VaultLoginControls';
import { button, click, createView } from './visibility.test-helper';

let view: ReturnType<typeof createView>;
beforeEach(() => { view = createView(); });
afterEach(async () => { vi.useRealTimers(); await view.dispose(); });

function handlers() {
  return { onLogin: vi.fn(), onLogout: vi.fn(), onCancelLogin: vi.fn(), onMigrate: vi.fn() };
}

type Props = React.ComponentProps<typeof VaultLoginControls>;

async function render(props: Partial<Props>) {
  const actions = handlers();
  await view.render(React.createElement(VaultLoginControls, {
    status: { enabled: true, loggedIn: false }, canLogIn: true, loggingIn: false, error: null, ...actions, ...props,
  }));
  return actions;
}

describe('VaultLoginControls', () => {
  it('offers login and keeps migration unavailable while logged out', async () => {
    const actions = await render({});

    expect(view.container.textContent).toContain('Not logged in');
    expect(button(view.container, 'Migrate Existing Secrets…').disabled).toBe(true);
    await click(button(view.container, 'Log In'));
    expect(actions.onLogin).toHaveBeenCalledOnce();
  });

  it('blocks login until the address and role are filled in', async () => {
    await render({ canLogIn: false });
    expect(button(view.container, 'Log In').disabled).toBe(true);
  });

  it('lets a browser login in progress be cancelled but not started twice', async () => {
    const actions = await render({ loggingIn: true });

    expect(button(view.container, 'Opening browser…').disabled).toBe(true);
    await click(button(view.container, 'Cancel login'));
    expect(actions.onCancelLogin).toHaveBeenCalledOnce();
  });

  it('shows who is logged in and for how long, with logout and migration', async () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z'), toFake: ['Date'] });
    const actions = await render({
      status: { enabled: true, loggedIn: true, identity: 'max@example.com', expiresAt: '2026-01-01T03:00:00Z' },
    });

    expect(view.container.textContent).toContain('Logged in as max@example.com, expires in 3h');
    expect([...view.container.querySelectorAll('button')].map(item => item.textContent)).not.toContain('Log In');
    await click(button(view.container, 'Log Out'));
    await click(button(view.container, 'Migrate Existing Secrets…'));
    expect(actions.onLogout).toHaveBeenCalledOnce();
    expect(actions.onMigrate).toHaveBeenCalledOnce();
  });

  it('omits identity and expiry the server did not report', async () => {
    await render({ status: { enabled: true, loggedIn: true } });
    expect(view.container.querySelector('.form-hint')?.textContent).toBe('● Logged in');
  });

  it('shows a login error', async () => {
    await render({ error: 'OIDC callback timed out' });
    expect(view.container.textContent).toContain('OIDC callback timed out');
  });
});

describe('formatExpiry', () => {
  beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z'), toFake: ['Date'] }); });

  it.each([
    [undefined, ''],
    ['not a date', 'not a date'],
    ['2025-12-31T23:59:00Z', 'expired'],
    ['2026-01-01T00:45:00Z', 'in 45m'],
    ['2026-01-01T05:00:00Z', 'in 5h'],
    ['2026-01-04T00:00:00Z', 'in 3d'],
  ])('describes %s as "%s"', (expiresAt, expected) => {
    expect(formatExpiry(expiresAt)).toBe(expected);
  });
});
