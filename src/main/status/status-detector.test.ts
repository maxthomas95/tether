import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StatusDetector } from './status-detector';
import type { WaitingReason } from '../../shared/types';

const ESC = '\x1b';
const BEL = '\x07';

describe('StatusDetector', () => {
  let detector: StatusDetector;
  let stateChanges: Array<{ sessionId: string; state: string; reason?: WaitingReason }>;

  // Tick past the 500ms transition debounce.
  const settle = () => vi.advanceTimersByTime(500);

  // Feed a chunk and tick past the debounce in one step.
  const feed = (id: string, data: string) => {
    detector.feedData(id, data);
    settle();
  };

  // Register a session, feed initial data, and tick past the debounce.
  const start = (id: string, data = 'output') => {
    detector.register(id);
    feed(id, data);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    detector = new StatusDetector();
    stateChanges = [];
    detector.onStateChange((sessionId, state, reason) => {
      stateChanges.push({ sessionId, state, reason });
    });
  });

  afterEach(() => {
    detector.dispose();
    vi.useRealTimers();
  });

  it('registers a session in starting state', () => {
    detector.register('s1');
    expect(detector.getState('s1')).toBe('starting');
  });

  it('returns starting for unknown sessions', () => {
    expect(detector.getState('nonexistent')).toBe('starting');
  });

  it('transitions to running when data arrives', () => {
    start('s1', 'hello world');
    expect(detector.getState('s1')).toBe('running');
    expect(stateChanges).toContainEqual({ sessionId: 's1', state: 'running' });
  });

  it('transitions to waiting after silence (non-hook CLI fallback)', () => {
    detector.register('s1', 'opencode');
    feed('s1', 'some streaming output');
    expect(detector.getState('s1')).toBe('running');

    // 3000ms silence → waiting fires; +500ms debounce
    vi.advanceTimersByTime(3000 + 500);
    expect(detector.getState('s1')).toBe('waiting');
  });

  it('transitions to idle after extended silence (non-hook CLI)', () => {
    detector.register('s1', 'opencode');
    feed('s1', 'some output');
    vi.advanceTimersByTime(3000 + 500);
    expect(detector.getState('s1')).toBe('waiting');

    // idle timeout (30s total - 3s already elapsed) + debounce
    vi.advanceTimersByTime(27000 + 500);
    expect(detector.getState('s1')).toBe('idle');
  });

  it('stays running for hook-enabled CLI when turn has not completed', () => {
    start('s1', 'codex output');

    // 3s silence — non-hook CLI would go waiting, but hook CLI stays running
    vi.advanceTimersByTime(3000 + 500);
    expect(detector.getState('s1')).toBe('running');

    // 30s total silence — still running, not idle
    vi.advanceTimersByTime(27000 + 500);
    expect(detector.getState('s1')).toBe('running');
  });

  it('markTurnComplete sets waiting state for hook-enabled CLI (idle via silence later)', () => {
    start('s1', 'claude output');
    detector.markTurnComplete('s1');
    expect(detector.getState('s1')).toBe('waiting');
    expect(detector.getWaitingReason('s1')).toBe('idle');

    // markTurnComplete clears all timers; no pending idle timer → stays at waiting.
    // The idle STATE is only reachable via the safety timer or a new feedData cycle.
    vi.advanceTimersByTime(60000);
    expect(detector.getState('s1')).toBe('waiting');
  });

  it('safety timer forces idle after TURN_SAFETY_TIMEOUT for hook-enabled CLI', () => {
    start('s1', 'codex output');

    // Stays running through normal silence timeouts
    vi.advanceTimersByTime(30000 + 500);
    expect(detector.getState('s1')).toBe('running');

    // Safety timeout (10 min) fires → hookSignaledDone flips true → idle
    vi.advanceTimersByTime(10 * 60 * 1000);
    settle();
    expect(detector.getState('s1')).toBe('idle');
  });

  it('resets timer when new data arrives', () => {
    detector.register('s1');
    detector.feedData('s1', 'chunk 1');
    vi.advanceTimersByTime(2000);
    detector.feedData('s1', 'chunk 2');
    vi.advanceTimersByTime(2000);
    // 2s since last data, not 3s — should still be running
    expect(detector.getState('s1')).toBe('running');
  });

  describe('exit handling', () => {
    it.each([
      { exitCode: 0, expected: 'stopped' as const },
      { exitCode: 1, expected: 'dead' as const },
    ])('exit code $exitCode → $expected', ({ exitCode, expected }) => {
      detector.register('s1');
      detector.markExited('s1', exitCode);
      expect(detector.getState('s1')).toBe(expected);
      expect(stateChanges).toContainEqual({ sessionId: 's1', state: expected });
    });

    it('does not let a pending debounce overwrite exited state', () => {
      detector.register('s1');
      detector.feedData('s1', 'output');
      detector.markExited('s1', 1);

      vi.advanceTimersByTime(60000);

      expect(detector.getState('s1')).toBe('dead');
      expect(stateChanges).not.toContainEqual({ sessionId: 's1', state: 'running' });
    });

    it('ignores data that arrives after exit', () => {
      detector.register('s1');
      detector.markExited('s1', 0);
      feed('s1', 'late output');

      expect(detector.getState('s1')).toBe('stopped');
    });
  });

  it('cleans up timers on unregister', () => {
    start('s1');
    detector.unregister('s1');
    vi.advanceTimersByTime(60000);
    // State is gone — falls back to 'starting'
    expect(detector.getState('s1')).toBe('starting');
  });

  describe('OSC 9 notification tap (Layer 1)', () => {
    it.each([
      { name: 'BEL terminator', data: `streaming...${ESC}]9;ready${BEL}` },
      { name: 'ST terminator', data: `streaming...${ESC}]9;done${ESC}\\` },
    ])('immediately flips waiting on OSC 9 with $name', ({ data }) => {
      start('s1', data);
      // Just the debounce — no need to wait for the silence timeout
      expect(detector.getState('s1')).toBe('waiting');
    });

    it('matches OSC 9 split across two chunks', () => {
      detector.register('s1');
      // First chunk has start of OSC sequence but no terminator
      feed('s1', `output${ESC}]9;Claude is`);
      expect(detector.getState('s1')).toBe('running');

      // Second chunk completes it
      feed('s1', ` ready${BEL}more output`);
      expect(detector.getState('s1')).toBe('waiting');
    });

    it('returns to running when more output arrives after a turn-end', () => {
      start('s1', `turn 1 done${ESC}]9;done${BEL}`);
      expect(detector.getState('s1')).toBe('waiting');

      // New agent activity (no OSC) should flip back to running
      feed('s1', 'starting next turn');
      expect(detector.getState('s1')).toBe('running');
    });

    it('does not match malformed OSC 9 with no terminator', () => {
      start('s1', `output${ESC}]9;no terminator here`);
      expect(detector.getState('s1')).toBe('running');
    });
  });

  it('handles multiple sessions independently', () => {
    detector.register('s1');
    detector.register('s2');
    feed('s1', 'output');
    expect(detector.getState('s1')).toBe('running');
    expect(detector.getState('s2')).toBe('starting');

    detector.markExited('s2', 1);
    expect(detector.getState('s1')).toBe('running');
    expect(detector.getState('s2')).toBe('dead');
  });

  it('cleans up all state on dispose', () => {
    start('s1', 'data');
    start('s2', 'data');
    detector.dispose();
    // After dispose, states should be cleared — getState falls back to 'starting'
    expect(detector.getState('s1')).toBe('starting');
    expect(detector.getState('s2')).toBe('starting');
  });

  describe('hook event integration', () => {
    it('markPermissionWaiting flips to waiting+permission immediately (no debounce)', () => {
      start('s1', 'output');
      stateChanges.length = 0;
      detector.markPermissionWaiting('s1');
      // No settle() — the hook path bypasses debounce because permission
      // prompts need to surface to the user right away.
      expect(detector.getState('s1')).toBe('waiting');
      expect(detector.getWaitingReason('s1')).toBe('permission');
      expect(stateChanges).toEqual([{ sessionId: 's1', state: 'waiting', reason: 'permission' }]);
    });

    it('markTurnComplete flips to waiting+idle and clears any pending fallback', () => {
      start('s1', 'output');
      stateChanges.length = 0;
      detector.markTurnComplete('s1');
      expect(detector.getState('s1')).toBe('waiting');
      expect(detector.getWaitingReason('s1')).toBe('idle');
      // Even if we tick forward a long way, the existing silence-fallback
      // timer was cleared so we don't double-fire transitions.
      vi.advanceTimersByTime(60000);
      const waitingTransitions = stateChanges.filter(c => c.state === 'waiting');
      expect(waitingTransitions).toHaveLength(1);
    });

    it('clears waitingReason when data resumes', () => {
      start('s1', 'output');
      detector.markPermissionWaiting('s1');
      expect(detector.getWaitingReason('s1')).toBe('permission');
      feed('s1', 'more data');
      expect(detector.getState('s1')).toBe('running');
      expect(detector.getWaitingReason('s1')).toBeUndefined();
    });

    it('byte-level waiting transition sets reason=idle, not permission', () => {
      detector.register('s1', 'opencode');
      detector.feedData('s1', 'output');
      vi.advanceTimersByTime(500); // settle running
      vi.advanceTimersByTime(3000); // hit WAITING_TIMEOUT
      vi.advanceTimersByTime(500); // settle waiting
      expect(detector.getState('s1')).toBe('waiting');
      expect(detector.getWaitingReason('s1')).toBe('idle');
    });

    it('hook methods are no-ops for unknown sessions', () => {
      detector.markPermissionWaiting('does-not-exist');
      detector.markTurnComplete('does-not-exist');
      expect(stateChanges).toHaveLength(0);
    });

    it('upgrades waiting+idle to waiting+permission when a permission_prompt arrives mid-wait', () => {
      // Non-hook CLI: byte-level inference flips to waiting+idle, then a
      // hypothetical hook upgrades the reason.
      detector.register('s1', 'opencode');
      detector.feedData('s1', 'output');
      vi.advanceTimersByTime(500);
      vi.advanceTimersByTime(3500); // waiting+idle
      stateChanges.length = 0;
      detector.markPermissionWaiting('s1');
      expect(detector.getWaitingReason('s1')).toBe('permission');
      expect(stateChanges).toEqual([{ sessionId: 's1', state: 'waiting', reason: 'permission' }]);
    });

    it('markPermissionWaiting flips from running to waiting+permission for hook-enabled CLI', () => {
      start('s1', 'output');
      stateChanges.length = 0;
      // Hook fires while CLI is still in running (silence timers suppressed)
      detector.markPermissionWaiting('s1');
      expect(detector.getState('s1')).toBe('waiting');
      expect(detector.getWaitingReason('s1')).toBe('permission');
    });
  });
});
