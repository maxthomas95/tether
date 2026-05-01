import { listOpencodeSessionIdsForCwd } from './transcripts';
import { createLogger } from '../logger';

const log = createLogger('opencode-watcher');

// Ids already claimed by a running Tether session, so two concurrent opencode
// detections in the same cwd don't both latch onto the same new session row.
const claimedIds = new Set<string>();

export interface OpencodeDetectHandle {
  promise: Promise<string | null>;
  cancel(): void;
}

export interface OpencodeDetectOptions {
  workingDir: string;
  /** Poll cadence in ms. Default 1000. Higher than codex because each tick
   * spawns a child process, which is more expensive than a directory scan. */
  pollIntervalMs?: number;
  /** Give up after this many ms of no new session. Default 60_000. */
  timeoutMs?: number;
}

/**
 * Watch opencode for a new session whose `directory` matches `workingDir`,
 * created after this call. opencode mints a `ses_…` id at first turn and
 * persists it in its SQLite store; we discover it by polling
 * `opencode session list --format json`.
 */
export function detectNewOpencodeSession(opts: OpencodeDetectOptions): OpencodeDetectHandle {
  const { workingDir, pollIntervalMs = 1000, timeoutMs = 60_000 } = opts;

  let cancelled = false;
  let timer: NodeJS.Timeout | null = null;

  const promise = new Promise<string | null>((resolve) => {
    let preexisting: Set<string> | null = null;
    const start = Date.now();

    const poll = async () => {
      if (cancelled) {
        resolve(null);
        return;
      }
      const ids = await listOpencodeSessionIdsForCwd(workingDir);
      if (preexisting === null) {
        // First tick: snapshot whatever's already there so we only latch onto
        // ids that appear *after* the spawn.
        preexisting = new Set(ids);
      } else {
        const candidate = ids.find(id => !preexisting!.has(id) && !claimedIds.has(id));
        if (candidate) {
          claimedIds.add(candidate);
          log.info('Captured opencode session id', { workingDir, id: candidate });
          resolve(candidate);
          return;
        }
      }

      if (Date.now() - start > timeoutMs) {
        log.warn('Opencode session id detection timed out', { workingDir });
        resolve(null);
        return;
      }
      timer = setTimeout(poll, pollIntervalMs);
    };
    poll();
  });

  return {
    promise,
    cancel: () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/** Release a claimed opencode session id (e.g. after the owning session is removed). */
export function releaseOpencodeSessionClaim(id: string | null | undefined): void {
  if (id) claimedIds.delete(id);
}
