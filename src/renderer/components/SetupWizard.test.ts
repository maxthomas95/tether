// @vitest-environment jsdom
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentInfo, GitProviderInfo, VaultStatus } from '../../shared/types';
import { button, change, click, createView, deferred } from './visibility.test-helper';

// The nested dialogs have their own suites; here they only need to hand a
// picked reference back to the wizard.
vi.mock('./VaultPickerDialog', () => ({
  VaultPickerDialog: ({ isOpen, onSelect, onClose }: { isOpen: boolean; onSelect: (ref: string) => void; onClose: () => void }) => isOpen
    ? React.createElement('div', { 'data-testid': 'vault-picker' },
        React.createElement('button', { onClick: () => onSelect('vault://secret/picked#value') }, 'Pick secret'),
        React.createElement('button', { onClick: onClose }, 'Close picker'))
    : null,
}));
vi.mock('./MigrateToVaultDialog', () => ({
  MigrateToVaultDialog: ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) => isOpen
    ? React.createElement('button', { onClick: onClose }, 'Close migration')
    : null,
}));

import { SetupWizard } from './SetupWizard';

type Props = React.ComponentProps<typeof SetupWizard>;

const LOGGED_IN: VaultStatus = { enabled: true, loggedIn: true, identity: 'oidc-max@example.com' };

interface Saved {
  config?: Record<string, string | null>;
  vaultConfig?: Record<string, unknown>;
  vaultStatus?: VaultStatus;
  providers?: GitProviderInfo[];
  environments?: EnvironmentInfo[];
  installed?: string[];
}

function stubApi(saved: Saved = {}) {
  const config = saved.config ?? {};
  let statusListener: (status: VaultStatus) => void = () => {};
  const api = {
    config: {
      get: vi.fn(async (key: string) => config[key] ?? null),
      set: vi.fn().mockResolvedValue(undefined),
    },
    vault: {
      getConfig: vi.fn(async () => saved.vaultConfig ?? { enabled: false }),
      status: vi.fn(async () => saved.vaultStatus ?? { enabled: false, loggedIn: false }),
      setConfig: vi.fn().mockResolvedValue(undefined),
      login: vi.fn(async () => LOGGED_IN),
      cancelLogin: vi.fn().mockResolvedValue(undefined),
      writeSecret: vi.fn().mockResolvedValue(undefined),
      onStatusChange: vi.fn((listener: (status: VaultStatus) => void) => { statusListener = listener; return () => {}; }),
    },
    gitProvider: {
      list: vi.fn(async () => saved.providers ?? []),
      create: vi.fn(async (options: { name: string; type: string }) => ({ id: 'provider-1', ...options })),
      test: vi.fn(async () => ({ ok: true }) as { ok: boolean; error?: string }),
    },
    environment: {
      list: vi.fn(async () => saved.environments ?? []),
      create: vi.fn(async (options: { name: string; type: string }) => ({ id: 'env-new', ...options })),
    },
    notifications: {
      getPrefs: vi.fn(async () => null),
      setPrefs: vi.fn().mockResolvedValue(undefined),
    },
    shell: { commandExists: vi.fn(async (binary: string) => (saved.installed ?? ['claude']).includes(binary)) },
    dialog: { openDirectory: vi.fn(async () => String.raw`D:\code`) },
  };
  window.electronAPI = api as unknown as typeof window.electronAPI;
  return { api, emitVaultStatus: (status: VaultStatus) => act(async () => statusListener(status)) };
}

let view: ReturnType<typeof createView>;
beforeEach(() => { view = createView(); });
afterEach(async () => view.dispose());

async function open(props: Partial<Props> = {}) {
  const handlers = { onClose: vi.fn(), onComplete: vi.fn(), onEnvironmentCreated: vi.fn(), onThemeChange: vi.fn() };
  await view.render(React.createElement(SetupWizard, { isOpen: true, ...handlers, ...props }));
  return handlers;
}

const text = () => view.container.textContent ?? '';
const field = (suffix: string) => view.container.querySelector<HTMLInputElement | HTMLSelectElement>(`[id$="-${suffix}"]`)!;
const fill = (suffix: string, value: string) => change(field(suffix), value);
const press = (label: string) => click(button(view.container, label));
const labelled = (label: string) => [...view.container.querySelectorAll('label')]
  .find(item => item.textContent?.trim() === label)!.querySelector<HTMLInputElement>('input')!;
const summary = () => [...view.container.querySelectorAll('.wizard-summary-item')].map(item => item.textContent);

/** Walk forward from the welcome screen, skipping what can be skipped. */
async function goToStep(target: 'vault' | 'environment' | 'hooks' | 'notifications' | 'provider' | 'ready') {
  await press('Get Started');
  await press('Skip');
  await press('Save & Continue');
  if (target === 'vault') return;
  await press('Skip');
  if (target === 'environment') return;
  await press('Save & Continue');
  if (target === 'hooks') return;
  await press('Save & Continue');
  if (target === 'notifications') return;
  await press('Save & Continue');
  if (target === 'provider') return;
  await press('Skip');
}

describe('SetupWizard', () => {
  it('renders nothing and reads no settings while closed', async () => {
    const { api } = stubApi();
    await open({ isOpen: false });

    expect(view.container.innerHTML).toBe('');
    expect(api.config.get).not.toHaveBeenCalled();
  });

  it('can be skipped outright or dismissed, without saving anything', async () => {
    const { api } = stubApi();
    const handlers = await open();

    await press('Skip Setup');
    expect(handlers.onComplete).toHaveBeenCalledWith({ openNewSession: false });

    await click(view.container.querySelector<HTMLElement>('.dialog-close')!);
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(handlers.onClose).toHaveBeenCalledTimes(2);
    expect(api.config.set).not.toHaveBeenCalled();
  });

  it('saves the projects root from typing or the folder picker, and requires one to save', async () => {
    const { api } = stubApi();
    await open();
    await press('Get Started');

    expect(button(view.container, 'Save & Continue').disabled).toBe(true);
    await press('Browse...');
    expect(field('repos-root').value).toBe(String.raw`D:\code`);
    await fill('repos-root', String.raw`  C:\repo  `);
    await press('Save & Continue');

    expect(api.config.set).toHaveBeenCalledWith('reposRoot', String.raw`C:\repo`);
    expect(field('theme')).not.toBeNull();
    await press('Back');
    expect(field('repos-root').value).toBe(String.raw`  C:\repo  `);
  });

  it('applies a theme as it is chosen and persists it, even when the save fails', async () => {
    const { api } = stubApi({ config: { theme: 'nord' } });
    const handlers = await open();
    await press('Get Started');
    await press('Skip');

    expect(field('theme').value).toBe('nord');
    await fill('theme', 'tether-light');
    expect(handlers.onThemeChange).toHaveBeenCalledWith('tether-light');

    api.config.set.mockRejectedValueOnce(new Error('disk full'));
    await press('Save & Continue');
    expect(api.config.set).toHaveBeenCalledWith('theme', 'tether-light');
    expect(text()).toContain('Secure secrets with Vault');
  });

  it('will not enable Vault without an address and role, then saves a trimmed configuration', async () => {
    const { api } = stubApi();
    await open();
    await goToStep('vault');

    await click(labelled('Enable Vault integration'));
    expect(button(view.container, 'Save & Continue').disabled).toBe(true);
    expect(button(view.container, 'Save & Log In').disabled).toBe(true);

    await fill('vault-address', ' https://vault.example.com ');
    await fill('vault-role', ' dev ');
    await fill('vault-mount', '');
    await fill('vault-namespace', ' team ');
    await press('Save & Continue');

    expect(api.vault.setConfig).toHaveBeenCalledWith({
      enabled: true, addr: 'https://vault.example.com', role: 'dev', mount: 'secret', namespace: 'team',
    });
    expect(text()).toContain('Choose your default CLI and environment');
  });

  it('logs in to Vault through the browser, can cancel, and reports a failed login', async () => {
    const { api, emitVaultStatus } = stubApi({ vaultConfig: { enabled: true, addr: 'https://vault.example.com', role: 'dev' } });
    await open();
    await goToStep('vault');
    expect(text()).toContain('Not logged in');
    expect(button(view.container, 'Migrate Existing Secrets...').disabled).toBe(true);

    const pending = deferred<VaultStatus>();
    api.vault.login.mockReturnValueOnce(pending.promise);
    await press('Save & Log In');
    expect(button(view.container, 'Opening browser...').disabled).toBe(true);
    await press('Cancel login');
    expect(api.vault.cancelLogin).toHaveBeenCalledOnce();
    await act(async () => pending.reject(new Error('Login cancelled')));
    expect(text()).toContain('Login cancelled');

    await press('Save & Log In');
    expect(api.vault.setConfig).toHaveBeenCalledTimes(2);
    expect(text()).toContain('Logged in');
    expect(button(view.container, 'Log In Again')).toBeDefined();

    await press('Migrate Existing Secrets...');
    await press('Close migration');

    await emitVaultStatus({ enabled: true, loggedIn: false });
    expect(text()).toContain('Not logged in');
  });

  it('reports a Vault configuration that cannot be saved and stays on the step', async () => {
    const { api } = stubApi({ vaultConfig: { enabled: true, addr: 'https://vault.example.com', role: 'dev' } });
    api.vault.setConfig.mockRejectedValueOnce(new Error('address is not reachable'));
    await open();
    await goToStep('vault');

    await press('Save & Continue');

    expect(text()).toContain('address is not reachable');
    expect(text()).toContain('Secure secrets with Vault');
  });

  it('shows which CLIs are installed and saves the default, requiring a binary for Custom', async () => {
    const { api } = stubApi({ installed: ['claude'], environments: [{ id: 'local', name: 'Local', type: 'local' } as EnvironmentInfo] });
    await open();
    await goToStep('environment');

    expect(text()).toContain('claude was found on this machine.');
    expect(text()).toContain('Codex CLI: not found');
    expect(text()).toContain('Existing environments: Local (local)');

    await fill('default-cli-tool', 'codex');
    expect(text()).toContain("codex was not found on this machine's PATH.");

    await fill('default-cli-tool', 'custom');
    expect(button(view.container, 'Save & Continue').disabled).toBe(true);
    await fill('custom-cli-binary', ' my-agent ');
    await press('Save & Continue');

    expect(api.config.set).toHaveBeenCalledWith('defaultCliTool', 'custom');
    expect(api.config.set).toHaveBeenCalledWith('defaultCustomCliBinary', 'my-agent');
    expect(api.environment.create).not.toHaveBeenCalled();
    expect(text()).toContain('Install Tether hooks');
  });

  it('creates an SSH environment with agent auth and sensible defaults', async () => {
    const { api } = stubApi();
    const handlers = await open();
    await goToStep('environment');

    await fill('environment-setup', 'ssh');
    expect(button(view.container, 'Save & Continue').disabled).toBe(true);
    await fill('ssh-host', ' dev.example.com ');
    await fill('ssh-port', 'not-a-port');
    await press('Save & Continue');

    expect(api.environment.create).toHaveBeenCalledWith({
      name: 'dev.example.com', type: 'ssh', envVars: {},
      config: { host: 'dev.example.com', port: 22, username: 'root', defaultDir: '~', useAgent: true },
    });
    expect(handlers.onEnvironmentCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'env-new', name: 'dev.example.com' }));
    expect(api.config.set).toHaveBeenCalledWith('defaultCustomCliBinary', '');
  });

  it('requires the secret that the chosen SSH auth method needs', async () => {
    const { api } = stubApi();
    await open();
    await goToStep('environment');
    await fill('environment-setup', 'ssh');
    await fill('environment-name', 'Dev Server');
    await fill('ssh-host', 'dev.example.com');
    await fill('ssh-port', '2222');
    await fill('ssh-username', 'max');
    await fill('ssh-default-directory', '~/repos');

    await click(labelled('Private Key File'));
    expect(button(view.container, 'Save & Continue').disabled).toBe(true);
    await fill('ssh-key-path', '~/.ssh/id_ed25519');
    expect(button(view.container, 'Save & Continue').disabled).toBe(false);

    await click(labelled('Password'));
    expect(button(view.container, 'Save & Continue').disabled).toBe(true);
    await fill('ssh-password', 'hunter2');
    await click(labelled('Run as root (sudo -i)'));
    await press('Save & Continue');

    expect(api.vault.writeSecret).not.toHaveBeenCalled();
    expect(api.environment.create).toHaveBeenCalledWith({
      name: 'Dev Server', type: 'ssh', envVars: {},
      config: { host: 'dev.example.com', port: 2222, username: 'max', defaultDir: '~/repos', password: 'hunter2', useSudo: true },
    });
  });

  it('stores an SSH password in Vault and saves only the reference', async () => {
    const { api } = stubApi({ vaultConfig: { enabled: true, addr: 'https://vault.example.com', role: 'dev', mount: 'kv' }, vaultStatus: LOGGED_IN });
    await open();
    await goToStep('environment');
    await fill('environment-setup', 'ssh');
    await fill('ssh-host', 'dev.example.com');
    await click(labelled('Password'));
    await fill('ssh-password', 'hunter2');
    await click(labelled('Store in Vault'));

    const suggested = 'vault://kv/max@example.com/tether/ssh/dev-example-com#password';
    expect(field('ssh-vault-path').value).toBe(suggested);
    await press('Save & Continue');

    expect(api.vault.writeSecret).toHaveBeenCalledWith(suggested, 'hunter2');
    const created = api.environment.create.mock.calls[0][0] as unknown as { config: { password: string } };
    expect(created.config.password).toBe(suggested);
  });

  it('uses a secret picked from Vault as-is, with no option to store it again', async () => {
    const { api } = stubApi({ vaultConfig: { enabled: true, addr: 'https://vault.example.com', role: 'dev' }, vaultStatus: LOGGED_IN });
    await open();
    await goToStep('environment');
    await fill('environment-setup', 'ssh');
    await fill('ssh-host', 'dev.example.com');
    await click(labelled('Password'));

    await press('Browse Vault');
    await press('Close picker');
    expect(field('ssh-password').value).toBe('');
    await press('Browse Vault');
    await press('Pick secret');

    expect(view.container.querySelector('[data-testid="vault-picker"]')).toBeNull();
    expect([...view.container.querySelectorAll('label')].some(item => item.textContent?.trim() === 'Store in Vault')).toBe(false);
    await press('Save & Continue');
    expect(api.vault.writeSecret).not.toHaveBeenCalled();
    const created = api.environment.create.mock.calls[0][0] as unknown as { config: { password: string } };
    expect(created.config.password).toBe('vault://secret/picked#value');
  });

  it('creates a Coder environment and reports a failure without advancing', async () => {
    const { api } = stubApi();
    api.environment.create.mockRejectedValueOnce(new Error('coder CLI not found'));
    await open();
    await goToStep('environment');
    await fill('environment-setup', 'coder');
    await fill('coder-cli-path', '  ');

    await press('Save & Continue');
    expect(text()).toContain('coder CLI not found');
    expect(text()).toContain('Choose your default CLI and environment');

    await press('Save & Continue');
    expect(api.environment.create).toHaveBeenLastCalledWith({ name: 'Coder', type: 'coder', config: { binaryPath: 'coder' }, envVars: {} });
    expect(text()).toContain('Install Tether hooks');
  });

  it('keeps hooks off unless opted in, and saves notification choices', async () => {
    const { api } = stubApi();
    await open();
    await goToStep('hooks');

    await press('Save & Continue');
    expect(api.config.set).toHaveBeenCalledWith('cliHooksEnabled', 'false');
    await press('Back');
    await click(view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    await press('Save & Continue');
    expect(api.config.set).toHaveBeenLastCalledWith('cliHooksEnabled', 'true');

    const boxes = [...view.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    const before = boxes.map(box => box.checked);
    for (const box of boxes) await click(box);
    api.notifications.setPrefs.mockRejectedValueOnce(new Error('ignored'));
    await press('Save & Continue');

    const prefs = api.notifications.setPrefs.mock.calls[0][0] as Record<string, boolean>;
    expect([prefs.onWaiting, prefs.onIdle, prefs.onError, prefs.onBell, prefs.suppressWhenFocused]).toEqual(before.map(value => !value));
    expect(text()).toContain('Connect a Git provider');
  });

  it('adds a GitHub provider with the default API URL and shows the connection test result', async () => {
    const { api } = stubApi({ providers: [{ id: 'g0', name: 'Work', type: 'gitea' } as GitProviderInfo] });
    await open();
    await goToStep('provider');

    expect(text()).toContain('Existing providers: Work (gitea)');
    expect(button(view.container, 'Save & Test').disabled).toBe(true);
    await fill('provider-name', ' GitHub ');
    await fill('provider-token', ' ghp_token ');
    await press('Save & Test');

    expect(api.gitProvider.create).toHaveBeenCalledWith({
      name: 'GitHub', type: 'github', baseUrl: 'https://api.github.com', organization: undefined, defaultProject: undefined, token: 'ghp_token',
    });
    expect(api.gitProvider.test).toHaveBeenCalledWith('provider-1');
    expect(text()).toContain('GitHub saved. Connection test passed.');

    await press('Add Another Provider');
    expect(field('provider-name').value).toBe('');
    expect(field('provider-token').value).toBe('');
  });

  it('requires an organization for Azure DevOps and reports a failed connection test', async () => {
    const { api } = stubApi();
    api.gitProvider.test.mockResolvedValueOnce({ ok: false });
    await open();
    await goToStep('provider');

    await click(labelled('Azure DevOps'));
    await fill('provider-name', 'ADO');
    await fill('provider-token', 'pat');
    expect(button(view.container, 'Save & Test').disabled).toBe(true);
    await fill('provider-org', ' contoso ');
    await fill('provider-default-project', ' Platform ');
    await press('Save & Test');

    expect(api.gitProvider.create).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ado', baseUrl: 'https://dev.azure.com', organization: 'contoso', defaultProject: 'Platform',
    }));
    expect(text()).toContain('Connection test failed: Unknown error');
  });

  it('needs a base URL for Gitea, and keeps the form when the provider cannot be saved', async () => {
    const { api } = stubApi();
    api.gitProvider.create.mockRejectedValueOnce(new Error('Git provider base URL must use HTTPS'));
    await open();
    await goToStep('provider');

    await click(labelled('Gitea'));
    await fill('provider-name', 'Gitea');
    await fill('provider-token', 'token');
    expect(button(view.container, 'Save & Test').disabled).toBe(true);
    await fill('provider-url', 'http://git.example.com');
    await press('Save & Test');

    expect(text()).toContain('Git provider base URL must use HTTPS');
    expect(field('provider-name').value).toBe('Gitea');
    expect(api.gitProvider.test).not.toHaveBeenCalled();
  });

  it('stores a provider token in Vault at a path the user can edit, or accepts a picked reference', async () => {
    const { api } = stubApi({ vaultConfig: { enabled: true, addr: 'https://vault.example.com', role: 'dev' }, vaultStatus: LOGGED_IN });
    await open();
    await goToStep('provider');
    await fill('provider-name', 'GitHub');
    await fill('provider-token', 'ghp_token');
    await click(labelled('Store in Vault'));

    expect(field('provider-vault-path').value).toBe('vault://secret/max@example.com/tether/git/github#token');
    await fill('provider-vault-path', ' vault://secret/custom#token ');
    await press('Save & Test');
    expect(api.vault.writeSecret).toHaveBeenCalledWith('vault://secret/custom#token', 'ghp_token');
    expect(api.gitProvider.create).toHaveBeenLastCalledWith(expect.objectContaining({ token: 'vault://secret/custom#token' }));

    await press('Add Another Provider');
    await fill('provider-name', 'Second');
    await press('Browse Vault');
    await press('Pick secret');
    // A picked reference is shown in the clear and can be discarded.
    expect(field('provider-token').getAttribute('type')).toBe('text');
    await press('Clear');
    expect(button(view.container, 'Save & Test').disabled).toBe(true);
    await press('Browse Vault');
    await press('Pick secret');
    await press('Save & Test');
    expect(api.vault.writeSecret).toHaveBeenCalledOnce();
    expect(api.gitProvider.create).toHaveBeenLastCalledWith(expect.objectContaining({ token: 'vault://secret/picked#value' }));
  });

  it('refuses to store a secret in Vault once the login has lapsed', async () => {
    const { api, emitVaultStatus } = stubApi({ vaultConfig: { enabled: true, addr: 'https://vault.example.com', role: 'dev' }, vaultStatus: LOGGED_IN });
    await open();
    await goToStep('provider');
    await fill('provider-name', 'GitHub');
    await fill('provider-token', 'ghp_token');
    await click(labelled('Store in Vault'));
    await emitVaultStatus({ enabled: true, loggedIn: false });

    await press('Save & Test');

    expect(text()).toContain('Log in to Vault before storing the provider token there.');
    expect(api.vault.writeSecret).not.toHaveBeenCalled();
    expect(api.gitProvider.create).not.toHaveBeenCalled();
  });

  it('summarizes what was configured and offers to start the first session', async () => {
    stubApi({
      config: { reposRoot: String.raw`C:\repo`, defaultCliTool: 'codex' },
      vaultConfig: { enabled: true, addr: 'https://vault.example.com', role: 'dev' }, vaultStatus: LOGGED_IN,
      providers: [{ id: 'g0', name: 'Work', type: 'github' } as GitProviderInfo],
      environments: [{ id: 'e1', name: 'VM', type: 'ssh' } as EnvironmentInfo, { id: 'local', name: 'Local', type: 'local' } as EnvironmentInfo],
    });
    const handlers = await open();
    await goToStep('ready');

    expect(summary()).toEqual([
      String.raw`✓Projects root: C:\repo`, '✓Default CLI: Codex CLI', '—Remote environment: Skipped - Local is available',
      '✓Vault: Enabled and logged in', '✓Git provider: 1 configured',
    ]);

    await press('Create First Session');
    expect(handlers.onComplete).toHaveBeenCalledWith({ openNewSession: true });
    expect(text()).toContain('Get Started');
  });

  it('summarizes a fresh install where everything optional was skipped', async () => {
    stubApi({ config: { defaultCliTool: 'not-a-tool' } });
    const handlers = await open();
    await goToStep('ready');

    expect(summary()).toEqual([
      '—Projects root: Skipped', '✓Default CLI: Claude Code', '—Remote environment: Skipped - Local is available',
      '—Vault: Skipped', '—Git provider: Skipped',
    ]);
    await press('Start Using Tether');
    expect(handlers.onComplete).toHaveBeenCalledWith({ openNewSession: false });
  });
});
