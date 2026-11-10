import { describe, expect, it } from 'vitest';
import { ENDED_STATUS, isEndedState, isSessionWorking, plainStatusDotClass } from './session-status';

describe('ended session presentation', () => {
  it('keeps a clean stop and a failure distinct', () => {
    expect(ENDED_STATUS.stopped.dotClass).not.toBe(ENDED_STATUS.dead.dotClass);
    expect(ENDED_STATUS.stopped.text).not.toBe(ENDED_STATUS.dead.text);
    expect(ENDED_STATUS.stopped.label).not.toBe(ENDED_STATUS.dead.label);
  });

  it('recognizes only stopped and dead as ended', () => {
    expect(isEndedState('stopped')).toBe(true);
    expect(isEndedState('dead')).toBe(true);
    for (const state of ['starting', 'running', 'waiting', 'idle', undefined] as const) {
      expect(isEndedState(state)).toBe(false);
    }
  });

  it('maps every state to a status-dot class', () => {
    expect(plainStatusDotClass('starting')).toBe('running');
    expect(plainStatusDotClass('running')).toBe('running');
    expect(plainStatusDotClass('waiting')).toBe('waiting');
    expect(plainStatusDotClass('idle')).toBe('idle');
    expect(plainStatusDotClass('stopped')).toBe('stopped');
    expect(plainStatusDotClass('dead')).toBe('dead');
    expect(plainStatusDotClass(undefined)).toBe('idle');
  });
});

describe('isSessionWorking', () => {
  it('is true while a turn is in flight or a permission prompt is open', () => {
    expect(isSessionWorking({ state: 'starting' })).toBe(true);
    expect(isSessionWorking({ state: 'running' })).toBe(true);
    expect(isSessionWorking({ state: 'waiting', waitingReason: 'permission' })).toBe(true);
  });

  it('is false for a session resting at its prompt or already ended', () => {
    expect(isSessionWorking({ state: 'waiting', waitingReason: 'idle' })).toBe(false);
    expect(isSessionWorking({ state: 'waiting' })).toBe(false);
    expect(isSessionWorking({ state: 'idle' })).toBe(false);
    expect(isSessionWorking({ state: 'stopped' })).toBe(false);
    expect(isSessionWorking({ state: 'dead' })).toBe(false);
  });
});
