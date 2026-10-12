import { createLogger } from '../logger';

const log = createLogger('remote-auth');

/**
 * Hosts whose resident reader could not authenticate or elevate. A wrong
 * password is a failed logon on the directory behind the host, so it is never
 * retried on a timer: every retry is another failed attempt toward a lockout
 * of the person's account. The state is per environment and shared by every
 * reader that signs in with that environment's credentials (usage and
 * subagents), so one failure stops all of them after a single attempt.
 *
 * It ends when the credentials are known to have changed: the environment is
 * edited or deleted, or a new session on it connects (an SSH session with sudo
 * only starts once sudo has accepted the password).
 */
export class RemoteAuthError extends Error {
  constructor() {
    super('Remote authentication failed');
    this.name = 'RemoteAuthError';
  }
}

const failed = new Set<string>();
const listeners = new Set<(environmentId: string) => void>();

export function markRemoteAuthFailed(environmentId: string): void {
  if (failed.has(environmentId)) return;
  failed.add(environmentId);
  // The environment id only: never a host, user or password.
  log.warn('Remote sign-in failed; not retrying until the environment changes or a session connects', { environmentId });
}

export function isRemoteAuthFailed(environmentId: string): boolean {
  return failed.has(environmentId);
}

export function clearRemoteAuthFailure(environmentId: string): void {
  if (!failed.delete(environmentId)) return;
  for (const cb of listeners) {
    try { cb(environmentId); } catch { /* one listener never blocks another */ }
  }
}

/** Called when a failed environment is cleared, so a waiting reader can start again. */
export function onRemoteAuthCleared(cb: (environmentId: string) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Test seam. */
export function resetRemoteAuthState(): void {
  failed.clear();
  listeners.clear();
}
