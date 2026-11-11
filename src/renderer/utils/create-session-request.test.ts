import { describe, expect, it } from 'vitest';
import { buildLaunchRequest, relaunchRequest, withLegacyClaudeResume, type LaunchFormValues } from './create-session-request';

const blankForm: LaunchFormValues = {
  workingDir: '/repo', label: 'api', environmentId: '', env: {}, cliArgs: [],
  disabledFlags: new Set(), profileId: null, cliTool: 'claude', customBinary: 'leftover-cli', helmEnabled: false,
};

describe('buildLaunchRequest', () => {
  it('omits untouched selections so the main process applies its defaults', () => {
    expect(buildLaunchRequest(blankForm)).toEqual({
      workingDir: '/repo', label: 'api', cliTool: 'claude',
      environmentId: undefined, env: undefined, cliArgs: undefined, disabledInheritedFlags: undefined,
      profileId: undefined, customCliBinary: undefined, helmEnabled: undefined,
    });
  });

  it('carries every launch setting the dialog collected', () => {
    const request = buildLaunchRequest({
      ...blankForm, environmentId: 'env-1', env: { API_KEY: 'vault://kv/app#key' }, cliArgs: ['--verbose'],
      disabledFlags: new Set(['--dangerously-skip-permissions']), profileId: 'profile-1', cliTool: 'custom',
      customBinary: 'my-cli', helmEnabled: true,
    });

    expect(request).toMatchObject({
      environmentId: 'env-1', env: { API_KEY: 'vault://kv/app#key' }, cliArgs: ['--verbose'],
      disabledInheritedFlags: ['--dangerously-skip-permissions'], profileId: 'profile-1',
      cliTool: 'custom', customCliBinary: 'my-cli', helmEnabled: true,
    });
  });

  it('ignores a custom binary left over from another tool choice', () => {
    expect(buildLaunchRequest({ ...blankForm, cliTool: 'codex' }).customCliBinary).toBeUndefined();
  });

  it('adds the details only one launch path knows', () => {
    const request = buildLaunchRequest(blankForm, { worktreeOf: '/repo', resumeToolSessionId: 'abc', cloneUrl: 'https://example.com/r.git' });
    expect(request).toMatchObject({ worktreeOf: '/repo', resumeToolSessionId: 'abc', cloneUrl: 'https://example.com/r.git' });
  });
});

describe('relaunchRequest', () => {
  const source = {
    workingDir: '/repo', environmentId: 'env-1', cliTool: 'codex' as const, customCliBinary: undefined,
    helmEnabled: true, launchSnapshotId: 'snapshot-1',
  };

  it('reuses the saved launch settings rather than restating them', () => {
    expect(relaunchRequest(source, { label: 'api (2)' })).toEqual({
      workingDir: '/repo', environmentId: 'env-1', cliTool: 'codex', customCliBinary: undefined,
      helmEnabled: true, launchSnapshotId: 'snapshot-1', label: 'api (2)',
    });
  });

  it('treats a session without an environment as local', () => {
    expect(relaunchRequest({ ...source, environmentId: '' }).environmentId).toBeUndefined();
  });
});

describe('withLegacyClaudeResume', () => {
  it('mirrors the resume id for Claude, including when no tool was chosen', () => {
    expect(withLegacyClaudeResume({ workingDir: '/repo', cliTool: 'claude', resumeToolSessionId: 'abc' }).resumeClaudeSessionId).toBe('abc');
    expect(withLegacyClaudeResume({ workingDir: '/repo', resumeToolSessionId: 'abc' }).resumeClaudeSessionId).toBe('abc');
  });

  it('does not hand another tool a Claude resume id', () => {
    const request = withLegacyClaudeResume({ workingDir: '/repo', cliTool: 'codex', resumeToolSessionId: 'abc' });
    expect(request.resumeToolSessionId).toBe('abc');
    expect(request.resumeClaudeSessionId).toBeUndefined();
  });

  it('leaves a blank label for the default name', () => {
    expect(withLegacyClaudeResume({ workingDir: '/repo', label: '' }).label).toBeUndefined();
    expect(withLegacyClaudeResume({ workingDir: '/repo', label: 'api' }).label).toBe('api');
  });
});
