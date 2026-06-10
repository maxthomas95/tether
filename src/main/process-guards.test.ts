import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock electron so the logger can initialise (it imports `app` from electron).
vi.mock('electron', () => ({
  app: {
    getPath: () => process.cwd(),
  },
}));

// Capture all logger calls so we can assert on them without touching the FS.
const mockError = vi.fn();
vi.mock('./logger', () => ({
  createLogger: () => ({
    error: mockError,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Reset the module between tests so the `installed` guard resets each time.
// We use vi.resetModules() + dynamic re-import in the tests that need a fresh
// installation state; tests that share the installed module just clear mock
// call counts.

describe('installProcessGuards', () => {
  // Listeners we add during tests — cleaned up in afterEach.
  const addedListeners: Array<{ event: string; fn: (...args: unknown[]) => void }> = [];

  function captureAndRemoveListener(event: 'unhandledRejection' | 'uncaughtException') {
    // Return the most recently added listener for the given event.
    const listeners = process.listeners(event) as Array<(...args: unknown[]) => void>;
    return listeners[listeners.length - 1] ?? null;
  }

  afterEach(() => {
    // Remove any listeners our test added directly.
    for (const { event, fn } of addedListeners) {
      process.removeListener(event, fn as NodeJS.UncaughtExceptionListener);
    }
    addedListeners.length = 0;
    mockError.mockClear();
    vi.resetModules();
  });

  async function freshInstall() {
    // Re-import after resetModules so `installed` starts as false.
    const { installProcessGuards } = await import('./process-guards');
    const beforeRejection = process.listenerCount('unhandledRejection');
    const beforeException = process.listenerCount('uncaughtException');
    installProcessGuards();
    return { beforeRejection, beforeException };
  }

  it('registers exactly one unhandledRejection listener', async () => {
    const { beforeRejection } = await freshInstall();
    expect(process.listenerCount('unhandledRejection')).toBe(beforeRejection + 1);
  });

  it('registers exactly one uncaughtException listener', async () => {
    const { beforeException } = await freshInstall();
    expect(process.listenerCount('uncaughtException')).toBe(beforeException + 1);
  });

  it('is idempotent — calling twice adds only one listener per event', async () => {
    const { installProcessGuards } = await import('./process-guards');
    const beforeRejection = process.listenerCount('unhandledRejection');
    const beforeException = process.listenerCount('uncaughtException');

    installProcessGuards();
    installProcessGuards(); // second call must be a no-op

    expect(process.listenerCount('unhandledRejection')).toBe(beforeRejection + 1);
    expect(process.listenerCount('uncaughtException')).toBe(beforeException + 1);
  });

  describe('unhandledRejection handler', () => {
    beforeEach(async () => {
      await freshInstall();
    });

    it('logs message + stack when the rejection reason is an Error', () => {
      const err = new Error('test rejection');
      const listener = captureAndRemoveListener('unhandledRejection');
      expect(listener).not.toBeNull();

      listener!(err, Promise.resolve());

      expect(mockError).toHaveBeenCalledOnce();
      const [msg, data] = mockError.mock.calls[0] as [string, Record<string, string>];
      expect(msg).toContain('rejection');
      expect(data.reason).toContain('test rejection');
      expect(data.reason).toContain('Error');
    });

    it('coerces a non-Error reason via String()', () => {
      const listener = captureAndRemoveListener('unhandledRejection');
      listener!('plain string reason', Promise.resolve());

      expect(mockError).toHaveBeenCalledOnce();
      const [, data] = mockError.mock.calls[0] as [string, Record<string, string>];
      expect(data.reason).toBe('plain string reason');
    });

    it('does not call process.exit', () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit called'); });
      const listener = captureAndRemoveListener('unhandledRejection');

      expect(() => listener!(new Error('boom'), Promise.resolve())).not.toThrow();
      expect(exitSpy).not.toHaveBeenCalled();

      exitSpy.mockRestore();
    });
  });

  describe('uncaughtException handler', () => {
    beforeEach(async () => {
      await freshInstall();
    });

    it('logs the error message and stack', () => {
      const err = new Error('uncaught boom');
      const listener = captureAndRemoveListener('uncaughtException');
      expect(listener).not.toBeNull();

      listener!(err);

      expect(mockError).toHaveBeenCalledOnce();
      const [msg, data] = mockError.mock.calls[0] as [string, Record<string, string>];
      expect(msg).toContain('exception');
      expect(data.message).toContain('uncaught boom');
    });

    it('does not call process.exit', () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit called'); });
      const listener = captureAndRemoveListener('uncaughtException');

      expect(() => listener!(new Error('boom'))).not.toThrow();
      expect(exitSpy).not.toHaveBeenCalled();

      exitSpy.mockRestore();
    });
  });
});
