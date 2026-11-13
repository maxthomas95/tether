// @vitest-environment jsdom
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsDialog } from './SettingsDialog';
import { DEFAULT_KEYBINDINGS } from '../../shared/keybindings';
import { button, change, click, createView } from './visibility.test-helper';

let view: ReturnType<typeof createView>;
let saveFlags: ReturnType<typeof vi.fn>;
beforeEach(() => {
  view = createView();
  saveFlags = vi.fn().mockResolvedValue(undefined);
  const list = () => Promise.resolve([]);
  window.electronAPI = {
    platform: 'win32',
    config: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined),
      getDefaultEnvVars: async () => ({}), setDefaultEnvVars: vi.fn().mockResolvedValue(undefined),
      getDefaultCliFlagsPerTool: async () => ({ claude: ['--verbose'], codex: ['--model saved'], opencode: ['--pure'] }),
      setDefaultCliFlagsForTool: saveFlags },
    session: { list }, profile: { list }, gitProvider: { list }, knownHosts: { list },
    vault: { getConfig: async () => ({ enabled: false }), status: async () => ({ enabled: false }), setConfig: vi.fn().mockResolvedValue(undefined), onStatusChange: () => () => {} },
    notifications: { getPrefs: async () => null, setPrefs: vi.fn().mockResolvedValue(undefined) },
    quota: { setEnabled: vi.fn().mockResolvedValue(undefined) },
    jobs: { getSettings: async () => ({ enabled: false }), getStatus: async () => null, onStatusChange: () => () => {} },
    codex: { account: vi.fn(), configuration: vi.fn() },
  } as unknown as typeof window.electronAPI;
});
afterEach(async () => view.dispose());

describe('CLI settings navigation and persistence', () => {
  it('gives each tool shared controls and saves their independent launch defaults', async () => {
    await view.render(React.createElement(SettingsDialog, { isOpen: true, initialSection: 'cli-tools', onClose: vi.fn(),
      currentTheme: 'default-dark', onThemeChange: vi.fn(), onResetSessionFontSizes: vi.fn(), keybindings: DEFAULT_KEYBINDINGS,
      onKeybindingChange: vi.fn(), onKeybindingsResetAll: vi.fn(), onOpenCliMaintenance: vi.fn() }));
    expect(view.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('CLI tools');
    expect(view.container.textContent).toContain('Default Claude Code launch');
    // The tab of the default tool is marked, and a flag the guided field owns is not repeated as a chip.
    expect(button(view.container, 'Claude Code').dataset.default).toBe('true');
    expect(button(view.container, 'OpenCode').dataset.default).toBeUndefined();
    const chips = () => [...view.container.querySelectorAll('.cli-flag-chips code')].map(code => code.textContent);
    expect(chips()).toEqual([]);
    const claudeModel = view.container.querySelector<HTMLInputElement>('.codex-settings-launch input')!;
    await change(claudeModel, 'opus');
    await act(async () => claudeModel.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(chips()).toEqual([]);
    const custom = view.container.querySelector<HTMLInputElement>('[aria-label="Custom Claude Code flag"]')!;
    expect(button(view.container, 'Add flag').disabled).toBe(true);
    await change(custom, '--add-dir ../shared');
    await click(button(view.container, 'Add flag'));
    expect(chips()).toEqual(['--add-dir ../shared']);
    await click(view.container.querySelector<HTMLButtonElement>('[aria-label="Remove --add-dir ../shared"]')!);
    await change(claudeModel, '');
    await act(async () => claudeModel.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    await click(button(view.container, 'OpenCode'));
    const model = view.container.querySelector<HTMLInputElement>('.codex-settings-launch input')!;
    await change(model, 'provider/model');
    await act(async () => model.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    await click(button(view.container, 'Codex CLI'));
    expect(view.container.textContent).toContain('Default Codex launch');
    expect(window.electronAPI.codex.account).not.toHaveBeenCalled();
    expect(window.electronAPI.codex.configuration).not.toHaveBeenCalled();
    await click(button(view.container, 'Save'));
    expect(saveFlags).toHaveBeenCalledWith('claude', ['--verbose']);
    expect(saveFlags).toHaveBeenCalledWith('codex', ['--model saved']);
    expect(saveFlags).toHaveBeenCalledWith('opencode', ['--pure', '--model provider/model']);
  });
});
