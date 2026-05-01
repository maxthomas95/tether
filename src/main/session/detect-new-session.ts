import type { TranscriptInfo } from '../../shared/types';
import type { createLogger } from '../logger';

type Logger = ReturnType<typeof createLogger>;

export interface DetectNewSessionOptions {
  /** Returns transcripts visible in the relevant cwd at this moment. */
  list(): TranscriptInfo[] | Promise<TranscriptInfo[]>;
  /** Module-level claim set so concurrent detections in the same cwd don't collide. */
  claimedIds: Set<string>;
  /**
   * If true, snapshot the existing ids on the first tick rather than at call
   * time. Use this when listing is async/expensive and the snapshot cost
   * itself would slow the spawn path.
   */
  snapshotOnFirstTick?: boolean;
  /** Initial snapshot when `snapshotOnFirstTick` is false (default). Required in that mode. */
  preexistingIds?: Iterable<string>;
  pollIntervalMs?: number;
  timeoutMs?: number;
  logger: Logger;
  logLabel: string;
  logContext?: Record<string, unknown>;
}

export interface DetectHandle {
  promise: Promise<string | null>;
  cancel(): void;
}

/**
 * Generic "watch for a new session id" poller used by all CLI watchers.
 * Each tick lists current transcripts, filters out the ones that existed
 * before we started + ones already claimed, and resolves with the earliest
 * candidate by mtime (= the first new session that appeared after spawn —
 * which is the one this transport just started).
 */
export function detectNewSession(opts: DetectNewSessionOptions): DetectHandle {
  const {
    list,
    claimedIds,
    pollIntervalMs = 500,
    timeoutMs = 60_000,
    logger,
    logLabel,
    logContext,
    snapshotOnFirstTick = false,
    preexistingIds,
  } = opts;

  let cancelled = false;
  let timer: NodeJS.Timeout | null = null;

  let preexisting: Set<string> | null = snapshotOnFirstTick
    ? null
    : new Set(preexistingIds ?? []);

  const promise = new Promise<string | null>((resolve) => {
    const start = Date.now();
    const poll = async () => {
      if (cancelled) {
        resolve(null);
        return;
      }
      const items = await list();
      if (preexisting === null) {
        preexisting = new Set(items.map(t => t.id));
      } else {
        const candidates = items.filter(t => !preexisting!.has(t.id) && !claimedIds.has(t.id));
        if (candidates.length > 0) {
          // Earliest-by-mtime = the first session that appeared after we
          // started, which is the one this transport spawned.
          candidates.sort((a, b) => a.mtime.localeCompare(b.mtime));
          const found = candidates[0].id;
          claimedIds.add(found);
          logger.info(`Captured ${logLabel} session id`, { ...logContext, id: found });
          resolve(found);
          return;
        }
      }

      if (Date.now() - start > timeoutMs) {
        logger.warn(`${logLabel} session id detection timed out`, logContext);
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

export function makeReleaseClaim(claimedIds: Set<string>) {
  return (id: string | null | undefined): void => {
    if (id) claimedIds.delete(id);
  };
}
