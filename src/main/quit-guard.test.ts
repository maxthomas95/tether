import { describe, expect, it } from 'vitest';
import { countSessionsInFlight, shouldConfirmQuit } from './quit-guard';

describe('countSessionsInFlight', () => {
  it('counts starting, running, and permission-waiting sessions', () => {
    expect(countSessionsInFlight([
      { state: 'starting' },
      { state: 'running' },
      { state: 'waiting', waitingReason: 'permission' },
      { state: 'waiting', waitingReason: 'idle' },
      { state: 'stopped' },
    ])).toBe(3);
  });
});

describe('shouldConfirmQuit', () => {
  it.each([
    [{ configValue: undefined, inFlight: 1, alreadyConfirmed: false }, true],
    [{ configValue: 'true', inFlight: 2, alreadyConfirmed: false }, true],
    [{ configValue: 'false', inFlight: 1, alreadyConfirmed: false }, false],
    [{ configValue: undefined, inFlight: 0, alreadyConfirmed: false }, false],
    [{ configValue: undefined, inFlight: 1, alreadyConfirmed: true }, false],
  ])('returns %s for %o', (opts, expected) => {
    expect(shouldConfirmQuit(opts)).toBe(expected);
  });
});
