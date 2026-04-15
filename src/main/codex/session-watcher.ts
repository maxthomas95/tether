import { listCodexTranscripts } from './transcripts';
import { createLogger } from '../logger';

const log = createLogger('codex-watcher');

// Ids already claimed by a running Tether session, so two concurrent codex
// detections in the same cwd don't both latch onto the same new transcript.
const claimedIds = new Set<string>();

export interface CodexDetectHandle {
  promise: Promise<string | null>;
  cancel(): void;
}

export interface CodexDetectOptions {
  workingDir: string;
  /** Poll cadence in ms. Default 500. */
  pollIntervalMs?: number;
  /** Give up after this many ms of no new transcript. Default 60_000. */
  timeoutMs?: number;
}

/**
 * Watch the Codex sessions directory for a new jsonl transcript created in
 * `workingDir` after this call. Codex writes `session_meta` to a new jsonl
 * shortly after spawn, so this latches onto the id the running CLI is
 * actually using — not just "the most recent transcript in the folder",
 * which can belong to a different session.
 */
export function detectNewCodexSession(opts: CodexDetectOptions): CodexDetectHandle {
  const { workingDir, pollIntervalMs = 500, timeoutMs = 60_000 } = opts;

  const preexisting = new Set(
    listCodexTranscripts(workingDir, Number.MAX_SAFE_INTEGER).map(t => t.id),
  );

  let cancelled = false;
  let timer: NodeJS.Timeout | null = null;

  const promise = new Promise<string | null>((resolve) => {
    const start = Date.now();
    const poll = () => {
      if (cancelled) {
        resolve(null);
        return;
      }
      const candidates = listCodexTranscripts(workingDir, Number.MAX_SAFE_INTEGER)
        .filter(t => !preexisting.has(t.id) && !claimedIds.has(t.id));
      if (candidates.length > 0) {
        // Earliest-by-mtime = the first transcript created after we started,
        // which is the one this session spawned.
        candidates.sort((a, b) => a.mtime.localeCompare(b.mtime));
        const found = candidates[0].id;
        claimedIds.add(found);
        log.info('Captured codex session id', { workingDir, id: found });
        resolve(found);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        log.warn('Codex session id detection timed out', { workingDir });
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

/**
 * Release a claimed codex session id so it becomes available to future
 * detections again (e.g. after the owning session is removed).
 */
export function releaseCodexSessionClaim(id: string | null | undefined): void {
  if (id) claimedIds.delete(id);
}
