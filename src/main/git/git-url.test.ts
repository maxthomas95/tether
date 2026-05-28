import { describe, expect, it } from 'vitest';
import { gitProtocolEnv, validateGitRemoteUrl } from './git-url';

describe('git URL validation', () => {
  it('accepts HTTPS, SSH URL, and SCP-like SSH remotes', () => {
    expect(validateGitRemoteUrl('https://github.com/example/repo.git')).toBe('https://github.com/example/repo.git');
    expect(validateGitRemoteUrl('ssh://git@example.com/example/repo.git')).toBe('ssh://git@example.com/example/repo.git');
    expect(validateGitRemoteUrl('git@github.com:example/repo.git')).toBe('git@github.com:example/repo.git');
  });

  it('rejects git transports and values that can be parsed as options', () => {
    expect(() => validateGitRemoteUrl('ext::sh -c calc')).toThrow(/ext::/);
    expect(() => validateGitRemoteUrl('file:///tmp/repo')).toThrow(/protocol/);
    expect(() => validateGitRemoteUrl('--upload-pack=calc')).toThrow(/start/);
    expect(() => validateGitRemoteUrl('/tmp/repo')).toThrow(/HTTPS or SSH/);
  });

  it('rejects embedded credentials', () => {
    expect(() => validateGitRemoteUrl('https://token@example.com/repo.git')).toThrow(/credentials/);
  });

  it('sets a narrow Git protocol allowlist', () => {
    expect(gitProtocolEnv().GIT_ALLOW_PROTOCOL).toBe('https:ssh');
  });
});

