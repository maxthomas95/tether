import { listCodexTranscripts } from './transcripts';
import { createLogger } from '../logger';
import { detectNewSession, makeReleaseClaim, type DetectHandle } from '../session/detect-new-session';

const log = createLogger('codex-watcher');

// Ids already claimed by a running Tether session, so two concurrent codex
// detections in the same cwd don't both latch onto the same new transcript.
const claimedIds = new Set<string>();

export type CodexDetectHandle = DetectHandle;

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
  const { workingDir, pollIntervalMs, timeoutMs } = opts;
  const preexisting = listCodexTranscripts(workingDir, Number.MAX_SAFE_INTEGER).map(t => t.id);
  return detectNewSession({
    list: () => listCodexTranscripts(workingDir, Number.MAX_SAFE_INTEGER),
    claimedIds,
    preexistingIds: preexisting,
    pollIntervalMs,
    timeoutMs,
    logger: log,
    logLabel: 'codex',
    logContext: { workingDir },
  });
}

/**
 * Release a claimed codex session id so it becomes available to future
 * detections again (e.g. after the owning session is removed).
 */
export const releaseCodexSessionClaim = makeReleaseClaim(claimedIds);
