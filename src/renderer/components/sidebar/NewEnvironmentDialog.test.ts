// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { NewEnvironmentDialog } from './NewEnvironmentDialog';

vi.mock('../EnvVarEditor', () => ({ EnvVarEditor: () => null }));
vi.mock('../VaultPickerDialog', () => ({ VaultPickerDialog: () => null }));
vi.mock('../HelpAnchor', () => ({ HelpAnchor: () => null }));

// React tracks a controlled input through the native value setter, so
// assigning `input.value` directly would never reach the component's state.
function typeInto(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

it('validates Enter submission for local and SSH environment updates', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('electronAPI', {
    config: { get: vi.fn().mockResolvedValue('false') },
    vault: { status: vi.fn().mockResolvedValue({ enabled: false }), getConfig: vi.fn().mockResolvedValue({}) },
  });
  const onCreate = vi.fn();
  const onUpdate = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const show = async (type: 'local' | 'ssh', name: string, host = '') => act(async () => root.render(createElement(NewEnvironmentDialog, {
    isOpen: true, onClose: vi.fn(), onCreate, onUpdate,
    editing: { id: 'fixture', name, type, config: { host, useAgent: true }, envVars: {} },
  })));
  const press = async (key: string) => act(async () => {
    container.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
  try {
    await show('local', '');
    await press('Enter');
    expect(onUpdate).not.toHaveBeenCalled();
    await show('local', 'Local');
    await press('Escape');
    expect(onUpdate).not.toHaveBeenCalled();
    await press('Enter');
    expect(onUpdate).toHaveBeenCalledOnce();
    await show('ssh', 'Remote');
    await press('Enter');
    expect(onUpdate).toHaveBeenCalledOnce();
    await show('ssh', 'Remote', 'example.invalid');
    await press('Enter');
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onCreate).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it('keeps typed settings open when environment creation fails', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('electronAPI', {
    config: { get: vi.fn().mockResolvedValue('false') },
    vault: { status: vi.fn().mockResolvedValue({ enabled: false }), getConfig: vi.fn().mockResolvedValue({}) },
  });
  const onClose = vi.fn();
  const onCreate = vi.fn().mockResolvedValue(false);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(NewEnvironmentDialog, { isOpen: true, onClose, onCreate })));
    const [name, host] = container.querySelectorAll<HTMLInputElement>('input.form-input');
    await act(async () => {
      typeInto(name, 'Unreachable VM');
      if (host) typeInto(host, 'example.invalid');
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.form-btn--primary')!.click();
    });

    expect(onCreate).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    expect(name.value).toBe('Unreachable VM');
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it('closes after successful environment creation', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('electronAPI', {
    config: { get: vi.fn().mockResolvedValue('false') },
    vault: { status: vi.fn().mockResolvedValue({ enabled: false }), getConfig: vi.fn().mockResolvedValue({}) },
  });
  const onClose = vi.fn();
  const onCreate = vi.fn().mockResolvedValue(true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(NewEnvironmentDialog, { isOpen: true, onClose, onCreate })));
    const [name, host] = container.querySelectorAll<HTMLInputElement>('input.form-input');
    await act(async () => {
      typeInto(name, 'Reachable VM');
      if (host) typeInto(host, 'example.invalid');
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.form-btn--primary')!.click();
    });

    expect(onCreate).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
