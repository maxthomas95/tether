import { listCopilotTranscripts, listCopilotSessionDirs } from './transcripts';
import { createLogger } from '../logger';
import { detectNewSession, makeReleaseClaim, type DetectHandle } from '../session/detect-new-session';

const log = createLogger('copilot-watcher');

// Ids already claimed by a running Tether session, so two concurrent copilot
// detections in the same cwd don't both latch onto the same new session.
const claimedIds = new Set<string>();

export type CopilotDetectHandle = DetectHandle;

export interface CopilotDetectOptions {
  workingDir: string;
  /** Poll cadence in ms. Default 500. */
  pollIntervalMs?: number;
  /** Give up after this many ms of no new session dir. Default 60_000. */
  timeoutMs?: number;
}

/**
 * Watch ~/.copilot/session-state for a new session whose workspace.yaml cwd
 * matches `workingDir`. Copilot mints a UUID dir as soon as the session
 * starts, so we snapshot the existing dir set then poll for new entries —
 * once the new dir has a workspace.yaml that points at our cwd, we latch.
 *
 * The dirname IS the session id; we pass that to `copilot --resume <id>`.
 */
export function detectNewCopilotSession(opts: CopilotDetectOptions): CopilotDetectHandle {
  const { workingDir, pollIntervalMs, timeoutMs } = opts;
  // Snapshot ALL existing session dirs (across every cwd) — copilot's
  // workspace.yaml is written slightly after the dir is created, so a row
  // that's "ours by cwd" hasn't always been classifiable yet at snapshot
  // time. Diffing against the full id set is more reliable.
  const preexisting = listCopilotSessionDirs().map(s => s.id);
  return detectNewSession({
    list: () => listCopilotTranscripts(workingDir, Number.MAX_SAFE_INTEGER),
    claimedIds,
    preexistingIds: preexisting,
    pollIntervalMs,
    timeoutMs,
    logger: log,
    logLabel: 'copilot',
    logContext: { workingDir },
  });
}

/** Release a claimed copilot session id (e.g. after the owning session is removed). */
export const releaseCopilotSessionClaim = makeReleaseClaim(claimedIds);
