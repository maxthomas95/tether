import { describe, it, expect } from 'vitest';
import { hasDangerousSkipPermissions, withRootSandboxBypass } from './root-sandbox';

describe('hasDangerousSkipPermissions', () => {
  it('detects the flag as a standalone entry', () => {
    expect(hasDangerousSkipPermissions(['--dangerously-skip-permissions'])).toBe(true);
  });

  it('detects the flag inside a whitespace-packed entry', () => {
    expect(hasDangerousSkipPermissions(['--dangerously-skip-permissions --verbose'])).toBe(true);
  });

  it('is false for an empty / undefined arg list', () => {
    expect(hasDangerousSkipPermissions([])).toBe(false);
    expect(hasDangerousSkipPermissions()).toBe(false);
  });

  it('is false for unrelated flags', () => {
    expect(hasDangerousSkipPermissions(['--model', 'sonnet', '--verbose'])).toBe(false);
  });

  it('does not match a substring that is not the whole token', () => {
    expect(hasDangerousSkipPermissions(['--dangerously-skip-permissions-extra'])).toBe(false);
  });
});

describe('withRootSandboxBypass', () => {
  const claudeSkip = { cliTool: 'claude' as const, cliArgs: ['--dangerously-skip-permissions'] };

  it('adds IS_SANDBOX=1 for Claude + skip-permissions running as root', () => {
    const result = withRootSandboxBypass({ FOO: 'bar' }, claudeSkip, true);
    expect(result).toEqual({ FOO: 'bar', IS_SANDBOX: '1' });
  });

  it('does not mutate the input env', () => {
    const env = { FOO: 'bar' };
    const result = withRootSandboxBypass(env, claudeSkip, true);
    expect(env).toEqual({ FOO: 'bar' });
    expect(result).not.toBe(env);
  });

  it('is a no-op when not running as root', () => {
    const env = { FOO: 'bar' };
    expect(withRootSandboxBypass(env, claudeSkip, false)).toBe(env);
  });

  it('is a no-op without the skip-permissions flag', () => {
    const env = { FOO: 'bar' };
    expect(withRootSandboxBypass(env, { cliTool: 'claude', cliArgs: ['--model', 'sonnet'] }, true)).toBe(env);
  });

  it('is a no-op for non-Claude CLIs even with a skip-ish flag', () => {
    const env = { FOO: 'bar' };
    expect(withRootSandboxBypass(env, { cliTool: 'codex', cliArgs: ['--dangerously-skip-permissions'] }, true)).toBe(env);
  });

  it('defaults an omitted cliTool to Claude', () => {
    const result = withRootSandboxBypass({}, { cliArgs: ['--dangerously-skip-permissions'] }, true);
    expect(result.IS_SANDBOX).toBe('1');
  });

  it('respects a user-provided IS_SANDBOX (never overwrites it)', () => {
    const env = { IS_SANDBOX: '0' };
    const result = withRootSandboxBypass(env, claudeSkip, true);
    expect(result).toBe(env);
    expect(result.IS_SANDBOX).toBe('0');
  });

  it('respects a user-provided CLAUDE_CODE_BUBBLEWRAP (does not add IS_SANDBOX)', () => {
    const env = { CLAUDE_CODE_BUBBLEWRAP: '1' };
    const result = withRootSandboxBypass(env, claudeSkip, true);
    expect(result).toBe(env);
    expect(result.IS_SANDBOX).toBeUndefined();
  });
});
