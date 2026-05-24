import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { CliToolId, SessionState, WaitingReason } from '../../shared/types';

// Opt-in raw PTY byte capture for debugging the OSC tap. Set TETHER_PTY_CAPTURE=1
// before launching Tether to dump every PTY chunk per session to
// <userData>/logs/pty-<sessionId>.bin. Capped at 4 MB per session.
const PTY_CAPTURE = process.env.TETHER_PTY_CAPTURE === '1';
const PTY_CAPTURE_MAX = 4 * 1024 * 1024;
const ptyCaptureBytes = new Map<string, number>();
function capture(sessionId: string, data: string): void {
  if (!PTY_CAPTURE) return;
  const written = ptyCaptureBytes.get(sessionId) || 0;
  if (written >= PTY_CAPTURE_MAX) return;
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `pty-${sessionId}.bin`);
    const buf = Buffer.from(data, 'utf8');
    const slice = written + buf.length > PTY_CAPTURE_MAX
      ? buf.subarray(0, PTY_CAPTURE_MAX - written)
      : buf;
    fs.appendFileSync(file, slice);
    ptyCaptureBytes.set(sessionId, written + slice.length);
  } catch {
    // capture is best-effort; never disrupt the detector
  }
}

const WAITING_TIMEOUT = 3000;   // No data for 3s → assume waiting (fallback for non-OSC CLIs)
const IDLE_TIMEOUT = 30000;     // No data for 30s → idle
const DEBOUNCE_MS = 500;        // Debounce state transitions
const BUFFER_MAX = 4096;        // Per-session rolling byte buffer for OSC matching
const BELL_COALESCE_MS = 2000;  // Suppress bell notifications fired in this window
const TURN_SAFETY_TIMEOUT = 10 * 60 * 1000; // 10 min fallback if hook never fires

// CLIs where Tether installs hooks that fire markTurnComplete at end-of-turn.
// For these CLIs the byte-level idle timeout is suppressed while a turn is in
// progress — markTurnComplete is the canonical "done" signal. CLIs NOT in this
// set rely solely on byte-level silence for idle detection.
const HOOK_ENABLED_CLIS: ReadonlySet<CliToolId> = new Set<CliToolId>(['claude', 'codex']);

// OSC sequences that AI CLIs (notably Claude Code) emit at end-of-turn.
//   ESC ] 9 ; <text> BEL          — desktop notification
//   ESC ] 9 ; <text> ESC \        — same, ST terminator
// Built from char codes so the source contains no literal control characters.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const OSC_NOTIFICATION_RE = new RegExp(
  `${ESC}\\]9;[^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`,
);

export class StatusDetector {
  private readonly states = new Map<string, SessionState>();
  private readonly waitingReasons = new Map<string, WaitingReason>();
  private readonly buffers = new Map<string, string>();
  private readonly cliTools = new Map<string, CliToolId>();
  private readonly waitingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly safetyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * True once markTurnComplete has fired and no new PTY data has arrived
   * since. While false for a hook-enabled CLI, the byte-level idle timeout
   * is suppressed — the hook is the canonical end-of-turn signal, and CLIs
   * like Codex can go silent for 60–90+ seconds mid-turn while the model
   * processes large contexts.
   */
  private readonly hookSignaledDone = new Map<string, boolean>();
  /**
   * Last time we surfaced a bell for this session. Used to coalesce rapid
   * BEL spam (some CLIs ring on every error) into one notification per
   * window so the OS doesn't queue a wall of toasts.
   */
  private readonly lastBellAt = new Map<string, number>();
  private callback: ((sessionId: string, state: SessionState, reason?: WaitingReason) => void) | null = null;
  private bellCallback: ((sessionId: string) => void) | null = null;

  onStateChange(callback: (sessionId: string, state: SessionState, reason?: WaitingReason) => void): void {
    this.callback = callback;
  }

  /**
   * Subscribe to bell events. The detector scans each PTY chunk for the
   * ASCII BEL byte (0x07) and fires this callback at most once per
   * `BELL_COALESCE_MS` window per session — terminal applications often
   * ring on every error byte, so we'd flood the OS notification center
   * without coalescing.
   */
  onBell(callback: (sessionId: string) => void): void {
    this.bellCallback = callback;
  }

  register(sessionId: string, cliTool: CliToolId = 'claude'): void {
    this.states.set(sessionId, 'starting');
    this.cliTools.set(sessionId, cliTool);
    if (HOOK_ENABLED_CLIS.has(cliTool)) {
      this.hookSignaledDone.set(sessionId, true);
    }
  }

  unregister(sessionId: string): void {
    this.states.delete(sessionId);
    this.waitingReasons.delete(sessionId);
    this.cliTools.delete(sessionId);
    this.buffers.delete(sessionId);
    this.lastBellAt.delete(sessionId);
    this.hookSignaledDone.delete(sessionId);
    this.clearTimer(this.waitingTimers, sessionId);
    this.clearTimer(this.idleTimers, sessionId);
    this.clearTimer(this.debounceTimers, sessionId);
    this.clearTimer(this.safetyTimers, sessionId);
  }

  // Called for every chunk of PTY output — this is the passive tap
  feedData(sessionId: string, data: string): void {
    capture(sessionId, data);

    const state = this.states.get(sessionId);
    if (!state || state === 'stopped' || state === 'dead') return;

    // Bell side-channel: a single indexOf scan, no parsing. We don't strip
    // the byte (xterm.js will render/handle it on its own) — we only sniff
    // it so the notification service can decide whether to surface a toast.
    // Coalesced to one fire per BELL_COALESCE_MS to defang BEL-spamming CLIs.
    if (this.bellCallback && data.indexOf(BEL) !== -1) {
      const now = Date.now();
      const last = this.lastBellAt.get(sessionId) ?? 0;
      if (now - last >= BELL_COALESCE_MS) {
        this.lastBellAt.set(sessionId, now);
        try { this.bellCallback(sessionId); }
        catch { /* swallow — bell is a notification, never a critical path */ }
      }
    }

    // Maintain a rolling buffer so OSC sequences split across chunks still match.
    const prevBuffer = this.buffers.get(sessionId) || '';
    const combined = prevBuffer + data;
    const buffer = combined.length > BUFFER_MAX
      ? combined.slice(combined.length - BUFFER_MAX)
      : combined;
    this.buffers.set(sessionId, buffer);

    // Reset silence timers — fresh data has arrived.
    this.clearTimer(this.waitingTimers, sessionId);
    this.clearTimer(this.idleTimers, sessionId);

    // For hook-enabled CLIs, mark the turn as active (output is flowing,
    // hook hasn't signaled completion yet). The safety timer caps how long
    // we'll suppress the byte-level idle fallback when the hook is missing.
    const cliTool = this.cliTools.get(sessionId);
    if (cliTool && HOOK_ENABLED_CLIS.has(cliTool)) {
      this.hookSignaledDone.set(sessionId, false);
      this.resetSafetyTimer(sessionId);
    }

    // Layer 1: OSC 9 notification — strongest "turn ended" signal.
    // Search the combined buffer so split-across-chunks sequences still match.
    // Once matched, clear the buffer so a stale notification from a prior turn
    // doesn't keep re-firing as new (non-OSC) data arrives in subsequent chunks.
    if (OSC_NOTIFICATION_RE.test(buffer)) {
      this.transition(sessionId, 'waiting');
      this.buffers.set(sessionId, '');
    } else {
      // Data is flowing → running
      this.transition(sessionId, 'running');
    }

    // Layer 4: silence-based fallback. After WAITING_TIMEOUT with no further data,
    // assume the CLI has stopped streaming and is waiting on the user. This catches
    // CLIs that don't emit OSC notifications (Copilot, OpenCode, custom).
    // For hook-enabled CLIs mid-turn, both transitions are suppressed — the hook
    // is the canonical signal, and silence during an API call is normal.
    this.waitingTimers.set(sessionId, setTimeout(() => {
      const cli = this.cliTools.get(sessionId);
      const hookActive = cli && HOOK_ENABLED_CLIS.has(cli) && !this.hookSignaledDone.get(sessionId);

      const currentState = this.states.get(sessionId);
      if ((currentState === 'running' || currentState === 'starting') && !hookActive) {
        this.transition(sessionId, 'waiting');
      }

      // After IDLE_TIMEOUT total silence, drop to idle — unless a
      // hook-enabled CLI is mid-turn (the safety timer handles that case).
      this.idleTimers.set(sessionId, setTimeout(() => {
        const cur = this.states.get(sessionId);
        if ((cur === 'waiting' || cur === 'running') && !hookActive) {
          this.transition(sessionId, 'idle');
        }
      }, IDLE_TIMEOUT - WAITING_TIMEOUT));
    }, WAITING_TIMEOUT));
  }

  // Called when PTY exits
  markExited(sessionId: string, exitCode: number): void {
    if (!this.states.has(sessionId)) return;
    this.clearSessionTimers(sessionId);
    this.buffers.delete(sessionId);
    this.hookSignaledDone.delete(sessionId);
    const state: SessionState = exitCode === 0 ? 'stopped' : 'dead';
    this.setState(sessionId, state); // No debounce for exit
  }

  /**
   * Hook signal: the CLI is blocked on a permission prompt. Wins over any
   * pending byte-level inference — we flip to waiting+permission immediately
   * and bypass debounce because the user needs to see this fast. Clears any
   * pending idle-fallback timer so we don't drop to plain idle behind it.
   */
  markPermissionWaiting(sessionId: string): void {
    if (!this.states.has(sessionId)) return;
    this.clearTimer(this.waitingTimers, sessionId);
    this.clearTimer(this.idleTimers, sessionId);
    this.clearTimer(this.debounceTimers, sessionId);
    this.setState(sessionId, 'waiting', 'permission');
  }

  /**
   * Hook signal: Claude/Codex says the turn is over (Stop hook, Codex
   * agent-turn-complete, or Notification.idle_prompt). Flip to waiting+idle
   * — the existing byte-level fallback would have gotten here eventually, we
   * just don't have to wait for silence.
   */
  markTurnComplete(sessionId: string): void {
    if (!this.states.has(sessionId)) return;
    this.clearTimer(this.waitingTimers, sessionId);
    this.clearTimer(this.idleTimers, sessionId);
    this.clearTimer(this.debounceTimers, sessionId);
    this.clearTimer(this.safetyTimers, sessionId);
    this.hookSignaledDone.set(sessionId, true);
    this.setState(sessionId, 'waiting', 'idle');
  }

  getState(sessionId: string): SessionState {
    return this.states.get(sessionId) || 'starting';
  }

  getWaitingReason(sessionId: string): WaitingReason | undefined {
    return this.waitingReasons.get(sessionId);
  }

  private transition(sessionId: string, newState: SessionState): void {
    const currentState = this.states.get(sessionId);
    if (currentState === newState) return;

    // Debounce to prevent flicker
    this.clearTimer(this.debounceTimers, sessionId);
    this.debounceTimers.set(sessionId, setTimeout(() => {
      // Byte-level inference never claims a reason — fall back to 'idle'
      // when transitioning into waiting via this path, leaving the field
      // unset for any other state.
      const reason: WaitingReason | undefined = newState === 'waiting' ? 'idle' : undefined;
      this.setState(sessionId, newState, reason);
      this.debounceTimers.delete(sessionId);
    }, DEBOUNCE_MS));
  }

  private setState(sessionId: string, state: SessionState, reason?: WaitingReason): void {
    const prev = this.states.get(sessionId);
    const prevReason = this.waitingReasons.get(sessionId);
    // Only emit when something actually changed.
    if (prev === state && prevReason === reason) return;
    this.states.set(sessionId, state);
    if (state === 'waiting' && reason) {
      this.waitingReasons.set(sessionId, reason);
    } else {
      this.waitingReasons.delete(sessionId);
    }
    this.callback?.(sessionId, state, this.waitingReasons.get(sessionId));
  }

  private clearTimer(
    map: Map<string, ReturnType<typeof setTimeout>>,
    sessionId: string,
  ): void {
    const t = map.get(sessionId);
    if (t) {
      clearTimeout(t);
      map.delete(sessionId);
    }
  }

  private resetSafetyTimer(sessionId: string): void {
    this.clearTimer(this.safetyTimers, sessionId);
    this.safetyTimers.set(sessionId, setTimeout(() => {
      this.hookSignaledDone.set(sessionId, true);
      const cur = this.states.get(sessionId);
      if (cur === 'waiting' || cur === 'running') {
        this.transition(sessionId, 'idle');
      }
    }, TURN_SAFETY_TIMEOUT));
  }

  private clearSessionTimers(sessionId: string): void {
    this.clearTimer(this.waitingTimers, sessionId);
    this.clearTimer(this.idleTimers, sessionId);
    this.clearTimer(this.debounceTimers, sessionId);
    this.clearTimer(this.safetyTimers, sessionId);
  }

  dispose(): void {
    for (const map of [this.waitingTimers, this.idleTimers, this.debounceTimers, this.safetyTimers]) {
      for (const timer of map.values()) clearTimeout(timer);
      map.clear();
    }
    this.states.clear();
    this.waitingReasons.clear();
    this.buffers.clear();
    this.cliTools.clear();
    this.lastBellAt.clear();
    this.hookSignaledDone.clear();
  }
}

export const statusDetector = new StatusDetector();
