import { describe, expect, it } from 'vitest';
import { selectNextWaiting, type AttentionCandidate } from './attention-queue';

function mkSession(over: Partial<AttentionCandidate> & { id: string }): AttentionCandidate {
  return {
    state: 'waiting',
    ...over,
  };
}

describe('selectNextWaiting', () => {
  it('returns null when there are no sessions', () => {
    expect(selectNextWaiting([], new Map(), null)).toBeNull();
  });

  it('returns null when no session is waiting', () => {
    const sessions = [mkSession({ id: '1', state: 'running' }), mkSession({ id: '2', state: 'idle' })];
    expect(selectNextWaiting(sessions, new Map(), null)).toBeNull();
  });

  it('returns the single waiting session even if it is currentSessionId', () => {
    const sessions = [mkSession({ id: '1' })];
    expect(selectNextWaiting(sessions, new Map(), '1')).toBe('1');
  });

  it('sorts permission-reason before idle-reason regardless of timestamps', () => {
    const sessions = [
      mkSession({ id: 'idle-old', waitingReason: 'idle' }),
      mkSession({ id: 'perm-new', waitingReason: 'permission' }),
    ];
    const waitingSince = new Map([
      ['idle-old', 1000],
      ['perm-new', 9000],
    ]);
    expect(selectNextWaiting(sessions, waitingSince, null)).toBe('perm-new');
  });

  it('orders FIFO (oldest waitingSince first) among sessions with the same reason', () => {
    const sessions = [
      mkSession({ id: 'b', waitingReason: 'idle' }),
      mkSession({ id: 'a', waitingReason: 'idle' }),
      mkSession({ id: 'c', waitingReason: 'idle' }),
    ];
    const waitingSince = new Map([
      ['b', 2000],
      ['a', 1000],
      ['c', 3000],
    ]);
    expect(selectNextWaiting(sessions, waitingSince, null)).toBe('a');
  });

  it('wraps around when currentSessionId is last in the queue', () => {
    const sessions = [
      mkSession({ id: 'a' }),
      mkSession({ id: 'b' }),
      mkSession({ id: 'c' }),
    ];
    const waitingSince = new Map([
      ['a', 1000],
      ['b', 2000],
      ['c', 3000],
    ]);
    expect(selectNextWaiting(sessions, waitingSince, 'c')).toBe('a');
  });

  it('returns the entry after currentSessionId when it is mid-queue', () => {
    const sessions = [
      mkSession({ id: 'a' }),
      mkSession({ id: 'b' }),
      mkSession({ id: 'c' }),
    ];
    const waitingSince = new Map([
      ['a', 1000],
      ['b', 2000],
      ['c', 3000],
    ]);
    expect(selectNextWaiting(sessions, waitingSince, 'a')).toBe('b');
  });

  it('returns the first entry when currentSessionId is not in the queue', () => {
    const sessions = [
      mkSession({ id: 'a' }),
      mkSession({ id: 'b' }),
    ];
    const waitingSince = new Map([
      ['a', 1000],
      ['b', 2000],
    ]);
    expect(selectNextWaiting(sessions, waitingSince, 'not-waiting-session')).toBe('a');
  });

  it('sorts sessions missing from waitingSince after timestamped ones, stable by array index', () => {
    const sessions = [
      mkSession({ id: 'no-ts-1' }),
      mkSession({ id: 'has-ts' }),
      mkSession({ id: 'no-ts-2' }),
    ];
    const waitingSince = new Map([['has-ts', 500]]);
    const queueOrder: string[] = [];
    let current: string | null = null;
    for (let i = 0; i < sessions.length; i++) {
      const next = selectNextWaiting(sessions, waitingSince, current);
      if (next === null) break;
      queueOrder.push(next);
      current = next;
    }
    expect(queueOrder).toEqual(['has-ts', 'no-ts-1', 'no-ts-2']);
  });

  it('ignores non-waiting sessions when ranking', () => {
    const sessions = [
      mkSession({ id: 'a', state: 'running' }),
      mkSession({ id: 'b', state: 'waiting' }),
      mkSession({ id: 'c', state: 'dead' }),
    ];
    expect(selectNextWaiting(sessions, new Map(), null)).toBe('b');
  });
});
