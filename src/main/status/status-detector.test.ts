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

  it('transitions to waiting when prompt is detected after silence', () => {
    detector.register('s1');
    detector.feedData('s1', 'Some output\n❯ ');

    // 500ms debounce for running
    vi.advanceTimersByTime(500);
    expect(detector.getState('s1')).toBe('running');

    // 3000ms silence triggers prompt check
    vi.advanceTimersByTime(3000);
    // Plus 500ms debounce for waiting
    vi.advanceTimersByTime(500);
    expect(detector.getState('s1')).toBe('waiting');
  });

  it('transitions to idle after extended silence', () => {
    detector.register('s1');
    detector.feedData('s1', 'Some output\n> ');

    // running debounce + prompt timeout + waiting debounce
    vi.advanceTimersByTime(500 + 3000 + 500);
    expect(detector.getState('s1')).toBe('waiting');

    // idle timeout (30s total from last data, minus 3s already elapsed = 27s) + debounce
    vi.advanceTimersByTime(27000 + 500);
    expect(detector.getState('s1')).toBe('idle');
  });

  it('resets timer when new data arrives', () => {
    detector.register('s1');
    detector.feedData('s1', 'chunk 1\n> ');
    vi.advanceTimersByTime(2000);

    // New data resets the timer
    detector.feedData('s1', 'chunk 2\n> ');
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
    detector.feedData('s1', 'output\n> ');
    vi.advanceTimersByTime(500); // running

    detector.unregister('s1');
    // After unregister, the inactivity timer should not fire waiting/idle
    vi.advanceTimersByTime(60000);
    // State is gone — falls back to 'starting'
    expect(detector.getState('s1')).toBe('starting');
  });

  describe('prompt detection', () => {
    const promptPatterns = [
      'some output\n> ',
      'some output\n❯ ',
      'some output\n\u276f ',
    ];

    for (const pattern of promptPatterns) {
      it(`detects prompt pattern: ${JSON.stringify(pattern.slice(-4))}`, () => {
        detector.register('s1');
        detector.feedData('s1', pattern);

        // running debounce + prompt timeout + waiting debounce
        vi.advanceTimersByTime(500 + 3000 + 500);
        expect(detector.getState('s1')).toBe('waiting');
      });
    }

    it('does not detect prompt in regular output', () => {
      detector.register('s1');
      detector.feedData('s1', 'just regular text with no prompt');

      // running debounce + prompt timeout + debounce
      vi.advanceTimersByTime(500 + 3000 + 500);
      // Should stay running since no prompt was detected
      expect(detector.getState('s1')).toBe('running');
    });
  });

  it('strips ANSI escapes when detecting prompts', () => {
    detector.register('s1');
    // Prompt with ANSI color codes around it
    detector.feedData('s1', '\x1b[32m❯\x1b[0m ');

    vi.advanceTimersByTime(500 + 3000 + 500);
    expect(detector.getState('s1')).toBe('waiting');
  });

  it('handles multiple sessions independently', () => {
    detector.register('s1');
    detector.register('s2');

    detector.feedData('s1', 'output\n> ');
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
