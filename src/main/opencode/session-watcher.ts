import { listOpencodeTranscripts } from './transcripts';
import { createLogger } from '../logger';
import { detectNewSession, makeReleaseClaim, type DetectHandle } from '../session/detect-new-session';

const log = createLogger('opencode-watcher');

// Ids already claimed by a running Tether session, so two concurrent opencode
// detections in the same cwd don't both latch onto the same new session row.
const claimedIds = new Set<string>();

export type OpencodeDetectHandle = DetectHandle;

export interface OpencodeDetectOptions {
  workingDir: string;
  /** Poll cadence in ms. Default 1000. Higher than codex/copilot because each
   * tick spawns a child process, which is more expensive than a directory scan. */
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
  const { workingDir, pollIntervalMs = 1000, timeoutMs } = opts;
  return detectNewSession({
    list: () => listOpencodeTranscripts(workingDir, Number.MAX_SAFE_INTEGER),
    claimedIds,
    // The list call shells out, so snapshot lazily on the first tick rather
    // than blocking the spawn path with a synchronous pre-snapshot.
    snapshotOnFirstTick: true,
    pollIntervalMs,
    timeoutMs,
    logger: log,
    logLabel: 'opencode',
    logContext: { workingDir },
  });
}

/** Release a claimed opencode session id (e.g. after the owning session is removed). */
export const releaseOpencodeSessionClaim = makeReleaseClaim(claimedIds);
