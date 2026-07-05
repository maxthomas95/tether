/**
 * "Drain the queue" navigation for sessions blocked on the user.
 *
 * Pure and dependency-free: given the current sessions, when each one most
 * recently entered `waiting`, and the currently focused session, picks the
 * next session to jump to. Callers (keyboard shortcut, sidebar pill, menu
 * item) all funnel through `selectNextWaiting` so repeated presses cycle
 * through the same deterministic order.
 */

/** A session reduced to the fields the queue needs to rank it. */
export interface AttentionCandidate {
  id: string;
  state: string;
  waitingReason?: string;
}

/**
 * Rank the `waiting` sessions and return the id to jump to next, or `null`
 * if none are waiting.
 *
 * Ordering: permission-blocked sessions first (a stuck tool approval is more
 * urgent than a session merely idling on input), then oldest-`waitingSince`
 * first within each group (FIFO — repeated presses drain the queue in the
 * order sessions started waiting). Sessions with no `waitingSince` entry
 * sort after every timestamped one, in their original array order — this
 * covers the brief window between a session appearing in `sessions` and its
 * first state-change event landing.
 *
 * Once ranked, the result cycles from `currentSessionId`: the entry after it
 * in the queue (wrapping around), the queue's first entry if the current
 * session isn't in it, or the sole entry if it's the only one.
 */
export function selectNextWaiting(
  sessions: AttentionCandidate[],
  waitingSince: ReadonlyMap<string, number>,
  currentSessionId: string | null,
): string | null {
  const effectiveTimestamp = (id: string, index: number): number =>
    waitingSince.get(id) ?? Number.MAX_SAFE_INTEGER - (sessions.length - index);

  const queue = sessions
    .map((session, index) => ({ session, index }))
    .filter(({ session }) => session.state === 'waiting')
    .sort((a, b) => {
      const aPermission = a.session.waitingReason === 'permission' ? 0 : 1;
      const bPermission = b.session.waitingReason === 'permission' ? 0 : 1;
      if (aPermission !== bPermission) return aPermission - bPermission;
      return effectiveTimestamp(a.session.id, a.index) - effectiveTimestamp(b.session.id, b.index);
    })
    .map(({ session }) => session.id);

  if (queue.length === 0) return null;

  const currentIndex = currentSessionId ? queue.indexOf(currentSessionId) : -1;
  if (currentIndex === -1) return queue[0];
  return queue[(currentIndex + 1) % queue.length];
}
