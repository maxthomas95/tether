import type { SessionState, WaitingReason } from '../../shared/types';

/**
 * How an ended session is presented. A clean stop and a failure are different
 * events: `stopped` is dim gray, `dead` (non-zero exit or transport failure)
 * is red, and each has its own spoken label.
 */
export const ENDED_STATUS = {
  stopped: { dotClass: 'stopped', text: 'Stopped', label: 'Status: stopped' },
  dead: { dotClass: 'dead', text: 'Failed', label: 'Status: failed (exited with an error)' },
} as const;

export type EndedState = keyof typeof ENDED_STATUS;

/** The session's process has ended, cleanly or not. */
export function isEndedState(state: SessionState | undefined): state is EndedState {
  return state === 'stopped' || state === 'dead';
}

/**
 * Status-dot modifier for a pane header or search row, where the sidebar's
 * visibility-dependent attention states do not apply.
 */
export function plainStatusDotClass(state: SessionState | undefined): string {
  switch (state) {
    case 'running':
    case 'starting':
      return 'running';
    case 'waiting':
      return 'waiting';
    case 'stopped':
    case 'dead':
      return ENDED_STATUS[state].dotClass;
    default:
      return 'idle';
  }
}

/**
 * Stopping this session would interrupt something: a turn in flight, or a
 * permission prompt the CLI is blocked on. A session idling at its prompt can
 * be stopped and resumed without loss.
 */
export function isSessionWorking(session: { state: SessionState; waitingReason?: WaitingReason }): boolean {
  if (session.state === 'starting' || session.state === 'running') return true;
  return session.state === 'waiting' && session.waitingReason === 'permission';
}
