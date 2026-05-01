import { listCopilotTranscripts, listCopilotSessionDirs } from './transcripts';
import { createLogger } from '../logger';

const log = createLogger('copilot-watcher');

// Ids already claimed by a running Tether session, so two concurrent copilot
// detections in the same cwd don't both latch onto the same new session.
const claimedIds = new Set<string>();

export interface CopilotDetectHandle {
  promise: Promise<string | null>;
  cancel(): void;
}

export interface CopilotDetectOptions {
  workingDir: string;
  /** Poll cadence in ms. Default 500. Cheap directory scan. */
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
  const { workingDir, pollIntervalMs = 500, timeoutMs = 60_000 } = opts;

  const preexisting = new Set(listCopilotSessionDirs().map(s => s.id));

  let cancelled = false;
  let timer: NodeJS.Timeout | null = null;

  const promise = new Promise<string | null>((resolve) => {
    const start = Date.now();
    const poll = () => {
      if (cancelled) {
        resolve(null);
        return;
      }
      // Only consider session dirs whose workspace.yaml cwd matches ours,
      // and that didn't exist when we started watching.
      const candidates = listCopilotTranscripts(workingDir, Number.MAX_SAFE_INTEGER)
        .filter(t => !preexisting.has(t.id) && !claimedIds.has(t.id));

      if (candidates.length > 0) {
        // Earliest-by-mtime = the first session that appeared after we
        // started, which is the one this transport spawned.
        candidates.sort((a, b) => a.mtime.localeCompare(b.mtime));
        const found = candidates[0].id;
        claimedIds.add(found);
        log.info('Captured copilot session id', { workingDir, id: found });
        resolve(found);
        return;
      }

      if (Date.now() - start > timeoutMs) {
        log.warn('Copilot session id detection timed out', { workingDir });
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

/** Release a claimed copilot session id (e.g. after the owning session is removed). */
export function releaseCopilotSessionClaim(id: string | null | undefined): void {
  if (id) claimedIds.delete(id);
}
