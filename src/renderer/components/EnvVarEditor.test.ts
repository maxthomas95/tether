// @vitest-environment jsdom
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { button, change, click, createView, deferred } from './visibility.test-helper';

vi.mock('./VaultPickerDialog', () => ({
  VaultPickerDialog: ({ isOpen, onSelect, onClose }: { isOpen: boolean; onSelect: (ref: string) => void; onClose: () => void }) => isOpen
    ? React.createElement('div', null,
        React.createElement('button', { onClick: () => onSelect('vault://secret/picked#value') }, 'Pick secret'),
        React.createElement('button', { onClick: onClose }, 'Close picker'))
    : null,
}));

import { EnvVarEditor } from './EnvVarEditor';

type Props = React.ComponentProps<typeof EnvVarEditor>;

let view: ReturnType<typeof createView>;
beforeEach(() => { view = createView(); });
afterEach(async () => view.dispose());

function stubVault(overrides: Record<string, unknown> = {}) {
  const vault = {
    getConfig: vi.fn(async () => ({ enabled: true, mount: 'kv' })),
    status: vi.fn(async () => ({ enabled: true, loggedIn: true, identity: 'oidc-max@example.com' })),
    testRef: vi.fn(async () => ({ ok: true }) as { ok: boolean; error?: string }),
    writeSecret: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  window.electronAPI = { vault } as unknown as typeof window.electronAPI;
  return vault;
}

async function render(vars: Record<string, string>, props: Partial<Props> = {}) {
  const onChange = vi.fn();
  await view.render(React.createElement(EnvVarEditor, { vars, onChange, ...props }));
  return onChange;
}

const rows = () => [...view.container.querySelectorAll<HTMLElement>('.env-editor-row:not(.env-editor-row--inherited)')];
const keyInput = (index: number) => rows()[index].querySelector<HTMLInputElement>('.env-editor-key')!;
const valueInput = (index: number) => rows()[index].querySelector<HTMLInputElement>('.env-editor-value')!;
const rowButton = (index: number, label: string) => [...rows()[index].querySelectorAll('button')].find(item => item.textContent === label);
const latest = (onChange: ReturnType<typeof vi.fn>) => onChange.mock.calls.at(-1)?.[0];

describe('EnvVarEditor', () => {
  it('edits, adds and removes variables, reporting only rows that have a name', async () => {
    const onChange = await render({ NODE_ENV: 'development' }, { compact: true });
    expect(view.container.querySelector('.env-editor--compact')).not.toBeNull();

    await change(valueInput(0), 'production');
    expect(latest(onChange)).toEqual({ NODE_ENV: 'production' });

    await click(button(view.container, '+ Add Variable'));
    expect(rows()).toHaveLength(2);
    expect(latest(onChange)).toEqual({ NODE_ENV: 'production' });

    await change(keyInput(1), '  DEBUG  ');
    await change(valueInput(1), '1');
    expect(latest(onChange)).toEqual({ NODE_ENV: 'production', DEBUG: '1' });

    await click(rowButton(0, '×')!);
    expect(latest(onChange)).toEqual({ DEBUG: '1' });
  });

  it('masks values whose name looks secret until revealed', async () => {
    await render({ API_TOKEN: 'abc123', REGION: 'us-east-1' });

    expect(valueInput(0).type).toBe('password');
    expect(valueInput(1).type).toBe('text');
    expect(rows()[1].querySelector('.env-editor-reveal')).toBeNull();

    const reveal = rows()[0].querySelector<HTMLElement>('.env-editor-reveal')!;
    await click(reveal);
    expect(valueInput(0).type).toBe('text');
    expect(reveal.title).toBe('Hide');
    await click(reveal);
    expect(valueInput(0).type).toBe('password');
  });

  it('shows inherited variables read-only, hides their secrets, and lets one be overridden', async () => {
    const onChange = await render({ REGION: 'eu-west-1' }, {
      inheritedVars: { REGION: 'us-east-1', API_KEY: 'sk-secret', LOG_LEVEL: 'info' },
    });

    const inherited = [...view.container.querySelectorAll('.env-editor-row--inherited')]
      .map(row => [...row.querySelectorAll('input')].map(input => input.value));
    expect(inherited).toEqual([['API_KEY', '••••••'], ['LOG_LEVEL', 'info']]);

    await click([...view.container.querySelectorAll<HTMLElement>('.env-editor-row--inherited button')][1]);
    expect(latest(onChange)).toEqual({ REGION: 'eu-west-1', LOG_LEVEL: 'info' });
    expect(view.container.querySelectorAll('.env-editor-row--inherited')).toHaveLength(1);
  });

  it('offers presets for the chosen CLI and does not add one twice', async () => {
    const onChange = await render({ ANTHROPIC_MODEL: 'claude-fable-5-2' }, { cliTool: 'claude' });
    const presets = () => [...view.container.querySelectorAll<HTMLElement>('.env-editor-preset-key')].map(item => item.textContent);

    await click(button(view.container, 'Quick Add ↓'));
    expect(presets()).toContain('ANTHROPIC_API_KEY');
    expect(presets()).not.toContain('ANTHROPIC_MODEL');
    expect(presets()).not.toContain('OPENAI_API_KEY');

    await click(view.container.querySelector<HTMLElement>('.env-editor-preset-item')!);
    expect(latest(onChange)).toEqual({ ANTHROPIC_MODEL: 'claude-fable-5-2', ANTHROPIC_API_KEY: '' });
    expect(view.container.querySelector('.env-editor-presets')).toBeNull();

    await click(button(view.container, 'Quick Add ↓'));
    const next = view.container.querySelector<HTMLElement>('.env-editor-preset-item')!;
    await act(async () => { next.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    expect(Object.keys(latest(onChange))).toHaveLength(3);
  });

  it('says so when a tool has no presets or all of them are in use', async () => {
    await render({ OPENAI_API_KEY: 'sk' }, { cliTool: 'codex' });
    await click(button(view.container, 'Quick Add ↓'));
    expect(view.container.querySelector('.env-editor-presets')?.textContent).toBe('All presets added');

    await render({}, { cliTool: 'opencode' });
    expect(view.container.querySelector('.env-editor-presets')?.textContent).toBe('No presets for this tool');

    await render({});
    expect(view.container.querySelectorAll('.env-editor-preset-key').length).toBeGreaterThan(5);
  });

  it('keeps Vault actions away when Vault is off or logged out', async () => {
    const vault = stubVault();
    await render({ API_KEY: 'sk-secret' });
    expect(vault.status).not.toHaveBeenCalled();
    expect(rowButton(0, 'Vault')).toBeUndefined();

    stubVault({ status: vi.fn(async () => ({ enabled: true, loggedIn: false })) });
    await render({ API_KEY: 'sk-secret', REGION: 'us' }, { vaultEnabled: true });
    expect(rowButton(0, 'Vault')).toBeUndefined();
    expect(rowButton(0, 'Browse')).toBeUndefined();
  });

  it('moves a secret into Vault and keeps only the reference, which can be undone', async () => {
    const pending = deferred<void>();
    const vault = stubVault({ writeSecret: vi.fn(() => pending.promise) });
    const onChange = await render({ API_KEY: 'sk-secret', REGION: 'us' }, { vaultEnabled: true });
    expect(rowButton(1, 'Vault')).toBeUndefined();

    await click(rowButton(0, 'Vault')!);
    const ref = 'vault://kv/max@example.com/tether/env/api-key#value';
    expect(vault.writeSecret).toHaveBeenCalledWith(ref, 'sk-secret');
    expect(view.container.textContent).toContain('Writing...');

    await act(async () => pending.resolve());
    expect(latest(onChange)).toEqual({ API_KEY: ref, REGION: 'us' });
    expect(view.container.textContent).toContain(`✓ Written to ${ref}`);
    expect(valueInput(0).type).toBe('text');
    expect(rows()[0].querySelector('.env-editor-reveal')).toBeNull();

    await click(rowButton(0, 'Undo')!);
    expect(latest(onChange)).toEqual({ API_KEY: '', REGION: 'us' });
    expect(view.container.textContent).not.toContain('Written to');
  });

  it('leaves the literal value in place when the Vault write fails', async () => {
    stubVault({ writeSecret: vi.fn().mockRejectedValue(new Error('permission denied')) });
    const onChange = await render({ API_KEY: 'sk-secret' }, { vaultEnabled: true });

    await click(rowButton(0, 'Vault')!);

    expect(view.container.textContent).toContain('permission denied');
    expect(valueInput(0).value).toBe('sk-secret');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('picks an existing secret for an empty sensitive value', async () => {
    stubVault();
    const onChange = await render({ API_KEY: '' }, { vaultEnabled: true });

    await click(rowButton(0, 'Browse')!);
    await click(button(view.container, 'Close picker'));
    expect(onChange).not.toHaveBeenCalled();

    await click(rowButton(0, 'Browse')!);
    await click(button(view.container, 'Pick secret'));
    expect(latest(onChange)).toEqual({ API_KEY: 'vault://secret/picked#value' });
    expect(rowButton(0, 'Browse')).toBeUndefined();
  });

  it('tests that a Vault reference resolves and shows why when it does not', async () => {
    const vault = stubVault({
      testRef: vi.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, error: 'key not found' }).mockResolvedValueOnce({ ok: false }),
    });
    await render({ API_KEY: 'vault://kv/app#key' }, { vaultEnabled: true });

    await click(rowButton(0, 'Test')!);
    expect(vault.testRef).toHaveBeenCalledWith('vault://kv/app#key');
    expect(view.container.textContent).toContain('✓ Resolved');
    await click(rowButton(0, 'Test')!);
    expect(view.container.textContent).toContain('key not found');
    await click(rowButton(0, 'Test')!);
    expect(view.container.textContent).toContain('Failed');
  });
});
