// @vitest-environment jsdom
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliLaunchControls } from './CliLaunchControls';
import { CLI_TOOL_REGISTRY, readCliLaunchOption, updateCliLaunchOption } from '../../shared/cli-tools';
import { change, createView } from './visibility.test-helper';

let view: ReturnType<typeof createView>;
beforeEach(() => { view = createView(); });
afterEach(async () => view.dispose());

describe('shared native CLI launch controls', () => {
  it.each(['claude', 'opencode'] as const)('edits and clears %s models while preserving unrelated flags', async tool => {
    const onFlagsChange = vi.fn();
    await view.render(React.createElement(CliLaunchControls, { tool, title: 'Launch', flags: ['--model old', '--verbose'], onFlagsChange }));
    const input = view.container.querySelector('input')!;
    expect(input.value).toBe('old');
    await change(input, ' provider/new-model ');
    await act(async () => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(onFlagsChange).toHaveBeenLastCalledWith(['--verbose', '--model provider/new-model']);
    await change(input, '');
    await act(async () => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(onFlagsChange).toHaveBeenLastCalledWith(['--verbose']);
  });

  it('updates OpenCode model and agent independently, including split and equals presets', () => {
    const [model, agent] = CLI_TOOL_REGISTRY.opencode.launchOptions!;
    const flags = ['-m', 'provider/old', '--agent=plan', '--print-logs'];
    expect(readCliLaunchOption(flags, model)).toBe('provider/old');
    const result = updateCliLaunchOption(flags, model, 'provider/new');
    expect(result).toEqual({ flags: ['--agent=plan', '--print-logs', '--model provider/new'], conflict: null });
    expect(updateCliLaunchOption(result.flags, agent, '')).toEqual({ flags: ['--print-logs', '--model provider/new'], conflict: null });
  });

  it.each(['--model old --verbose', '--model old positional-prompt', '--model', '--model='])('preserves ambiguous manual presets: %s', flag => {
    const option = CLI_TOOL_REGISTRY.claude.launchOptions![0];
    const flags = [flag, '--verbose'];
    const result = updateCliLaunchOption(flags, option, 'new');
    expect(result.flags).toBe(flags);
    expect(result.conflict).toBeTruthy();
  });

  it('keeps positional text after an empty equals flag intact and accepts tab-separated identifiers', () => {
    const option = CLI_TOOL_REGISTRY.claude.launchOptions![0];
    const flags = ['--model=', 'positional-prompt'];
    expect(readCliLaunchOption(flags, option)).toBe('');
    expect(updateCliLaunchOption(flags, option, 'new').flags).toBe(flags);
    expect(updateCliLaunchOption(['--model\told'], option, 'new').flags).toEqual(['--model new']);
  });

  it('accepts Claude extended-context model aliases', () => {
    const option = CLI_TOOL_REGISTRY.claude.launchOptions![0];
    const result = updateCliLaunchOption([], option, 'sonnet[1m]');
    expect(result).toEqual({ flags: ['--model sonnet[1m]'], conflict: null });
    expect(readCliLaunchOption(result.flags, option)).toBe('sonnet[1m]');
  });

  it('shows a conflict and leaves saved flags intact for invalid identifiers', async () => {
    const onFlagsChange = vi.fn();
    await view.render(React.createElement(CliLaunchControls, { tool: 'opencode', title: 'Launch', flags: ['--model provider/old'], onFlagsChange }));
    const input = view.container.querySelector('input')!;
    await change(input, 'new --agent build');
    await act(async () => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('single');
    expect(onFlagsChange).not.toHaveBeenCalled();
  });
});
