// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { NewEnvironmentDialog } from './NewEnvironmentDialog';

vi.mock('../EnvVarEditor', () => ({ EnvVarEditor: () => null }));
vi.mock('../VaultPickerDialog', () => ({ VaultPickerDialog: () => null }));
vi.mock('../HelpAnchor', () => ({ HelpAnchor: () => null }));

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
