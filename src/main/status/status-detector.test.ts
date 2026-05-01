import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StatusDetector } from './status-detector';

describe('StatusDetector', () => {
  let detector: StatusDetector;
  let stateChanges: Array<{ sessionId: string; state: string }>;

  beforeEach(() => {
    vi.useFakeTimers();
    detector = new StatusDetector();
    stateChanges = [];
    detector.onStateChange((sessionId, state) => {
      stateChanges.push({ sessionId, state });
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
    detector.register('s1');
    detector.feedData('s1', 'hello world');

    // Debounce fires at 500ms
    vi.advanceTimersByTime(500);
    expect(detector.getState('s1')).toBe('running');
    expect(stateChanges).toContainEqual({ sessionId: 's1', state: 'running' });
  });

  it('transitions to waiting after silence (fallback)', () => {
    detector.register('s1');
    detector.feedData('s1', 'some streaming output');

    // 500ms debounce for running
    vi.advanceTimersByTime(500);
    expect(detector.getState('s1')).toBe('running');

    // 3000ms silence → waiting fires; +500ms debounce
    vi.advanceTimersByTime(3000 + 500);
    expect(detector.getState('s1')).toBe('waiting');
  });

  it('transitions to idle after extended silence', () => {
    detector.register('s1');
    detector.feedData('s1', 'some output');

    // running debounce + waiting timeout + waiting debounce
    vi.advanceTimersByTime(500 + 3000 + 500);
    expect(detector.getState('s1')).toBe('waiting');

    // idle timeout (30s total from last data, minus 3s already elapsed = 27s) + debounce
    vi.advanceTimersByTime(27000 + 500);
    expect(detector.getState('s1')).toBe('idle');
  });

  it('resets timer when new data arrives', () => {
    detector.register('s1');
    detector.feedData('s1', 'chunk 1');
    vi.advanceTimersByTime(2000);

    // New data resets the timer
    detector.feedData('s1', 'chunk 2');
    vi.advanceTimersByTime(2000);

    // Only 2s since last data, not 3s — should still be running
    expect(detector.getState('s1')).toBe('running');
  });

  it('marks exited with code 0 as stopped', () => {
    detector.register('s1');
    detector.feedData('s1', 'output');
    vi.advanceTimersByTime(500);

    detector.markExited('s1', 0);
    expect(detector.getState('s1')).toBe('stopped');
    expect(stateChanges).toContainEqual({ sessionId: 's1', state: 'stopped' });
  });

  it('marks exited with non-zero code as dead', () => {
    detector.register('s1');
    detector.markExited('s1', 1);
    expect(detector.getState('s1')).toBe('dead');
    expect(stateChanges).toContainEqual({ sessionId: 's1', state: 'dead' });
  });

  it('cleans up timers on unregister', () => {
    detector.register('s1');
    detector.feedData('s1', 'output');
    vi.advanceTimersByTime(500); // running

    detector.unregister('s1');
    // After unregister, timers should not fire transitions
    vi.advanceTimersByTime(60000);
    // State is gone — falls back to 'starting'
    expect(detector.getState('s1')).toBe('starting');
  });

  describe('OSC 9 notification tap (Layer 1)', () => {
    it('transitions immediately to waiting on OSC 9 with BEL terminator', () => {
      detector.register('s1');
      detector.feedData('s1', 'streaming...\x1b]9;Claude is ready\x07');

      // Just the debounce — no need to wait for the silence timeout
      vi.advanceTimersByTime(500);
      expect(detector.getState('s1')).toBe('waiting');
    });

    it('transitions immediately to waiting on OSC 9 with ST terminator', () => {
      detector.register('s1');
      detector.feedData('s1', 'streaming...\x1b]9;Done\x1b\\');

      vi.advanceTimersByTime(500);
      expect(detector.getState('s1')).toBe('waiting');
    });

    it('matches OSC 9 split across two chunks', () => {
      detector.register('s1');
      // First chunk has start of OSC sequence but no terminator
      detector.feedData('s1', 'output\x1b]9;Claude is');
      vi.advanceTimersByTime(500);
      expect(detector.getState('s1')).toBe('running');

      // Second chunk completes it
      detector.feedData('s1', ' ready\x07more output');
      vi.advanceTimersByTime(500);
      expect(detector.getState('s1')).toBe('waiting');
    });

    it('returns to running when more output arrives after a turn-end', () => {
      detector.register('s1');
      detector.feedData('s1', 'turn 1 done\x1b]9;done\x07');
      vi.advanceTimersByTime(500);
      expect(detector.getState('s1')).toBe('waiting');

      // New agent activity (no OSC) should flip back to running
      detector.feedData('s1', 'starting next turn');
      vi.advanceTimersByTime(500);
      expect(detector.getState('s1')).toBe('running');
    });

    it('does not match malformed OSC 9 with no terminator', () => {
      detector.register('s1');
      detector.feedData('s1', 'output\x1b]9;no terminator here');
      vi.advanceTimersByTime(500);
      expect(detector.getState('s1')).toBe('running');
    });
  });

  it('handles multiple sessions independently', () => {
    detector.register('s1');
    detector.register('s2');

    detector.feedData('s1', 'output');
    vi.advanceTimersByTime(500);
    expect(detector.getState('s1')).toBe('running');
    expect(detector.getState('s2')).toBe('starting');

    detector.markExited('s2', 1);
    expect(detector.getState('s1')).toBe('running');
    expect(detector.getState('s2')).toBe('dead');
  });

  it('cleans up all state on dispose', () => {
    detector.register('s1');
    detector.register('s2');
    detector.feedData('s1', 'data');
    detector.feedData('s2', 'data');

    detector.dispose();

    // After dispose, states should be cleared
    expect(detector.getState('s1')).toBe('starting'); // default fallback
    expect(detector.getState('s2')).toBe('starting');
  });
});
