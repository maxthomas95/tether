import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StatusDetector } from './status-detector';

const ESC = '\x1b';
const BEL = '\x07';

describe('StatusDetector', () => {
  let detector: StatusDetector;
  let stateChanges: Array<{ sessionId: string; state: string }>;

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
    start('s1', 'hello world');
    expect(detector.getState('s1')).toBe('running');
    expect(stateChanges).toContainEqual({ sessionId: 's1', state: 'running' });
  });

  it('transitions to waiting after silence (fallback)', () => {
    start('s1', 'some streaming output');
    expect(detector.getState('s1')).toBe('running');

    // 3000ms silence → waiting fires; +500ms debounce
    vi.advanceTimersByTime(3000 + 500);
    expect(detector.getState('s1')).toBe('waiting');
  });

  it('transitions to idle after extended silence', () => {
    start('s1', 'some output');
    vi.advanceTimersByTime(3000 + 500);
    expect(detector.getState('s1')).toBe('waiting');

    // idle timeout (30s total - 3s already elapsed) + debounce
    vi.advanceTimersByTime(27000 + 500);
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
});
