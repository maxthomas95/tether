import { createLogger } from '../logger';

const log = createLogger('remote-auth');

/**
 * Hosts whose resident reader could not authenticate or elevate: the host
 * refused the login or the sudo password, or a reader that was sent a password
 * gave no ready response within 30 seconds. A wrong password is a failed logon
 * on the directory behind the host, so it is never retried on a timer: every
 * retry is another failed attempt toward a lockout of the person's account.
 * The state is per environment and shared by every reader that signs in with
 * that environment's credentials (usage and subagents). Elevated connects are
 * also serialised per environment (`serialiseElevatedConnect`), so a second
 * reader cannot start a sudo while the first is still waiting to hear whether
 * the password was accepted: one failure stops all of them after a single
 * attempt.
 *
 * It ends when the credentials are known to have changed: the environment is
 * edited or deleted, or a new session on it connects (an SSH session with sudo
 * only starts once sudo has accepted the password). Each clear also bumps the
 * environment's generation, so an attempt that began with the old credentials
 * and fails after the edit is not held against the new ones.
 */
export class RemoteAuthError extends Error {
  constructor() {
    super('Remote authentication failed');
    this.name = 'RemoteAuthError';
  }
}

const failed = new Set<string>();
const generations = new Map<string, number>();
const gates = new Map<string, Promise<unknown>>();
const listeners = new Set<(environmentId: string) => void>();

/** Changes whenever the environment's credentials may have changed. */
export function authGeneration(environmentId: string): number {
  return generations.get(environmentId) ?? 0;
}

/**
 * Run an elevated connect so that only one is in flight per environment. A
 * caller that had to wait looks at the outcome before trying: if the first
 * attempt was refused, it gets the refusal instead of sending the password
 * again.
 */
export function serialiseElevatedConnect<T>(environmentId: string, attempt: () => Promise<T>): Promise<T> {
  const previous = gates.get(environmentId) ?? Promise.resolve();
  const run = previous.then(() => {
    if (failed.has(environmentId)) throw new RemoteAuthError();
    return attempt();
  });
  const tail = run.then(() => undefined, () => undefined);
  gates.set(environmentId, tail);
  void tail.then(() => { if (gates.get(environmentId) === tail) gates.delete(environmentId); });
  return run;
}

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
  generations.set(environmentId, authGeneration(environmentId) + 1);
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
  generations.clear();
  gates.clear();
  listeners.clear();
}
