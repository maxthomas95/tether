// @vitest-environment jsdom
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexLaunchControls, CodexSettingsSection } from './CodexSettingsSection';
import { readCodexLaunchFlags } from '../../shared/cli-tools';
import { button, change, click, createView } from './visibility.test-helper';
import type { CodexConfigurationSnapshot } from '../../shared/codex-types';

const configuration: CodexConfigurationSnapshot = {
  status: 'ready', error: null, lastUpdated: null, fields: [], integrations: [],
  profiles: [{ name: 'work' }, { name: 'personal' }, { name: 'work' }],
  models: [{ id: 'model-b', displayName: 'B', reasoningEfforts: ['high', 'xhigh'], defaultReasoningEffort: 'high' },
    { id: 'model-a', displayName: 'A', reasoningEfforts: [], defaultReasoningEffort: null }],
};
let view: ReturnType<typeof createView>;
beforeEach(() => {
  view = createView();
  window.electronAPI = { codex: { account: vi.fn(), configuration: vi.fn().mockResolvedValue(configuration) } } as unknown as typeof window.electronAPI;
});
afterEach(async () => view.dispose());

function control<T extends HTMLInputElement | HTMLSelectElement>(container: HTMLElement, label: string): T {
  const wrapper = [...container.querySelectorAll('label')].find(item => item.firstChild?.textContent?.trim() === label);
  expect(wrapper, label).toBeDefined();
  return wrapper!.querySelector<T>('input, select')!;
}

describe('guided Codex launch settings', () => {
  it('discovers choices, edits model/profile/reasoning and preserves other CLI settings', async () => {
    const props = { cliFlagsPerTool: { claude: ['--verbose'] }, profileCliFlagsPerTool: { claude: ['--debug'] },
      onCliFlagsPerToolChange: vi.fn(), onProfileCliFlagsPerToolChange: vi.fn(), showProfileControls: true,
      cliHooksEnabled: true, codexLifecycleHooksEnabled: false, onCodexLifecycleHooksEnabledChange: vi.fn(),
      quotaWarningPercent: 10, onQuotaWarningPercentChange: vi.fn(), sessions: [] };
    await view.render(React.createElement(CodexSettingsSection, props));
    await click(button(view.container, 'Inspect configuration'));
    const launches = view.container.querySelectorAll<HTMLElement>('.codex-settings-launch');
    const models = control<HTMLSelectElement>(launches[0], 'Model');
    expect([...models.options].map(option => option.value)).toEqual(['', 'model-a', 'model-b']);
    expect([...control<HTMLSelectElement>(launches[0], 'Native profile').options].map(option => option.value)).toEqual(['', 'personal', 'work']);
    await change(models, 'model-b');
    const defaults = props.onCliFlagsPerToolChange.mock.calls[0][0];
    expect(defaults.claude).toEqual(['--verbose']);
    expect(readCodexLaunchFlags(defaults.codex).model).toBe('model-b');
    await change(control<HTMLSelectElement>(launches[1], 'Native profile'), 'work');
    const profile = props.onProfileCliFlagsPerToolChange.mock.calls[0][0];
    expect(profile.claude).toEqual(['--debug']);
    expect(readCodexLaunchFlags(profile.codex).profile).toBe('work');
    await change(control<HTMLSelectElement>(launches[0], 'Reasoning'), 'high');
    expect(readCodexLaunchFlags(props.onCliFlagsPerToolChange.mock.lastCall![0].codex).reasoningEffort).toBe('high');
    await click(view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    expect(props.onCodexLifecycleHooksEnabledChange).toHaveBeenCalledWith(true);
    const warning = view.container.querySelector<HTMLInputElement>('#codex-quota-warning')!;
    for (const [value, expected] of [['120', 100], ['-1', 0], ['', 0], ['25', 25]] as const) {
      await change(warning, value);
      expect(props.onQuotaWarningPercentChange).toHaveBeenLastCalledWith(expected);
    }
    await view.render(React.createElement(CodexSettingsSection, { ...props, showProfileControls: false, cliHooksEnabled: false }));
    expect(view.container.querySelectorAll('.codex-settings-launch')).toHaveLength(1);
    expect(view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled).toBe(true);
  });

  it('applies trimmed manual values on blur and refreshes draft fields when saved flags change', async () => {
    const onFlagsChange = vi.fn();
    const props = { title: 'Launch', flags: ['--model model-b', '--profile work'], configuration, onFlagsChange };
    await view.render(React.createElement(CodexLaunchControls, props));
    expect([...control<HTMLSelectElement>(view.container, 'Reasoning').options].map(option => option.value)).toEqual(['', 'high', 'xhigh']);
    await change(control<HTMLInputElement>(view.container, 'Manual model'), '  custom-model  ');
    await act(async () => control(view.container, 'Manual model').dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(readCodexLaunchFlags(onFlagsChange.mock.lastCall![0])).toMatchObject({ model: 'custom-model', profile: 'work' });
    await change(control<HTMLInputElement>(view.container, 'Manual profile'), '  personal  ');
    await act(async () => control(view.container, 'Manual profile').dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(readCodexLaunchFlags(onFlagsChange.mock.lastCall![0])).toMatchObject({ model: 'model-b', profile: 'personal' });
    await view.render(React.createElement(CodexLaunchControls, { ...props, flags: ['--model model-a'] }));
    expect(control<HTMLInputElement>(view.container, 'Manual model').value).toBe('model-a');
    expect(control<HTMLInputElement>(view.container, 'Manual profile').value).toBe('');
    expect([...control<HTMLSelectElement>(view.container, 'Reasoning').options].map(option => option.value)).toEqual(['', 'high', 'low', 'medium']);
    await change(control<HTMLSelectElement>(view.container, 'Model'), '');
    expect(readCodexLaunchFlags(onFlagsChange.mock.lastCall![0]).model).toBeUndefined();
  });

  it('keeps ambiguous manual flags intact and explains why guided edits cannot apply', async () => {
    const onFlagsChange = vi.fn();
    await view.render(React.createElement(CodexLaunchControls, {
      title: 'Launch', flags: ['--model old-model explain-this'], configuration: null, onFlagsChange,
    }));
    await change(control<HTMLSelectElement>(view.container, 'Reasoning'), 'high');
    expect(view.container.querySelector('[role="alert"]')).not.toBeNull();
    expect(onFlagsChange).not.toHaveBeenCalled();
  });
});
