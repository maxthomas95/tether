const SCP_LIKE_SSH_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/;
const ALLOWED_GIT_PROTOCOLS = 'https:ssh';

export function validateGitRemoteUrl(input: string): string {
  const value = input.trim();
  if (!value) {
    throw new Error('Git remote URL must not be empty');
  }
  if (value.includes('\0') || /[\r\n]/.test(value)) {
    throw new Error('Git remote URL contains invalid control characters');
  }
  if (value.startsWith('-')) {
    throw new Error('Git remote URL must not start with "-"');
  }
  if (value.startsWith('ext::')) {
    throw new Error('Git ext:: transport is not allowed');
  }
  if (SCP_LIKE_SSH_RE.test(value)) {
    return value;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Git remote URL must be HTTPS or SSH');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'ssh:') {
    throw new Error(`Git remote URL protocol is not allowed: ${parsed.protocol}`);
  }
  if (!parsed.hostname) {
    throw new Error('Git remote URL must include a host');
  }
  if (parsed.protocol === 'https:' && (parsed.username || parsed.password)) {
    throw new Error('Git remote URL must not embed credentials');
  }
  return value;
}

export function gitProtocolEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_ALLOW_PROTOCOL: ALLOWED_GIT_PROTOCOLS,
  };
}
