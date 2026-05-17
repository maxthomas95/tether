/**
 * Shared primitives for CLI-config overlays (Claude `settings.json`,
 * Codex `config.toml`, future hosts). Each overlay file owns its own
 * mutex instance so writes to different config files don't serialize
 * unnecessarily — `createOverlayMutex` returns a private closure per call.
 */

/**
 * Sentinel substring identifying Tether-managed hook entries. Appears in the
 * helper path (`…/tether-cli-hook/index.js`) so we don't need to inject a
 * separate marker — scrub matches by substring.
 */
export const SENTINEL_TOKEN = 'tether-cli-hook';

/**
 * Returns a single-writer mutex bound to this call. Each overlay gets its
 * own — Claude and Codex installs don't have to wait on each other.
 */
export function createOverlayMutex(): <T>(fn: () => Promise<T> | T) => Promise<T> {
  let mutex: Promise<void> = Promise.resolve();
  return function withMutex<T>(fn: () => Promise<T> | T): Promise<T> {
    const prev = mutex;
    let release!: () => void;
    mutex = new Promise<void>((r) => { release = r; });
    return prev.then(async () => {
      try { return await fn(); }
      finally { release(); }
    });
  };
}
