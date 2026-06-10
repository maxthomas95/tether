/**
 * Shared primitives for CLI-config overlays (Claude `settings.json`,
 * Codex `config.toml`, future hosts). Each overlay file owns its own
 * mutex instance so writes to different config files don't serialize
 * unnecessarily — `createOverlayMutex` returns a private closure per call.
 */

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '../db/atomic-write';

/**
 * Filesystem seam for overlays. The pure merge/scrub logic in each overlay is
 * stream-agnostic text-in/text-out; all real I/O is routed through this
 * interface so the same merge can be driven against a local file today and a
 * remote (SSH/Coder) config file later, and so tests can exercise the
 * atomic-write path with an in-memory store.
 */
export interface ConfigFileStore {
  /**
   * Read a file as UTF-8 text, or `null` when it does not exist. Read/parse
   * errors other than "missing" surface to the caller (overlays log + degrade
   * to empty for Codex, but the contract here is faithful: ENOENT → null,
   * other errors → throw).
   */
  read(filePath: string): string | null;
  /** True if the path exists. */
  exists(filePath: string): boolean;
  /** Write `text` atomically (temp file + rename), creating parent dirs. */
  writeAtomic(filePath: string, text: string): void;
}

/**
 * Local-filesystem implementation: wraps the existing `fs` + atomic-write
 * behavior so overlays preserve byte-for-byte semantics. `read` distinguishes
 * "missing" (ENOENT → null) from genuine read failures (rethrown).
 */
export const localConfigFileStore: ConfigFileStore = {
  read(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  },
  exists(filePath: string): boolean {
    return fs.existsSync(filePath);
  },
  writeAtomic(filePath: string, text: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    atomicWriteFileSync(filePath, text);
  },
};

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
