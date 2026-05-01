import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { CliToolId, SessionState } from '../../shared/types';

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

// OSC sequences that AI CLIs (notably Claude Code) emit at end-of-turn.
//   ESC ] 9 ; <text> BEL          — desktop notification
//   ESC ] 9 ; <text> ESC \        — same, ST terminator
const OSC_NOTIFICATION_RE = /\x1b\]9;[^\x07\x1b]*(?:\x07|\x1b\\)/;

export class StatusDetector {
  private states = new Map<string, SessionState>();
  private buffers = new Map<string, string>();
  private cliTools = new Map<string, CliToolId>();
  private waitingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private callback: ((sessionId: string, state: SessionState) => void) | null = null;

  onStateChange(callback: (sessionId: string, state: SessionState) => void): void {
    this.callback = callback;
  }

  register(sessionId: string, cliTool: CliToolId = 'claude'): void {
    this.states.set(sessionId, 'starting');
    this.cliTools.set(sessionId, cliTool);
  }

  unregister(sessionId: string): void {
    this.states.delete(sessionId);
    this.cliTools.delete(sessionId);
    this.buffers.delete(sessionId);
    this.clearTimer(this.waitingTimers, sessionId);
    this.clearTimer(this.idleTimers, sessionId);
    this.clearTimer(this.debounceTimers, sessionId);
  }

  // Called for every chunk of PTY output — this is the passive tap
  feedData(sessionId: string, data: string): void {
    capture(sessionId, data);

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
    this.waitingTimers.set(sessionId, setTimeout(() => {
      const currentState = this.states.get(sessionId);
      if (currentState === 'running' || currentState === 'starting') {
        this.transition(sessionId, 'waiting');
      }

      // After IDLE_TIMEOUT total silence, drop to idle.
      this.idleTimers.set(sessionId, setTimeout(() => {
        const cur = this.states.get(sessionId);
        if (cur === 'waiting' || cur === 'running') {
          this.transition(sessionId, 'idle');
        }
      }, IDLE_TIMEOUT - WAITING_TIMEOUT));
    }, WAITING_TIMEOUT));
  }

  // Called when PTY exits
  markExited(sessionId: string, exitCode: number): void {
    const state: SessionState = exitCode === 0 ? 'stopped' : 'dead';
    this.setState(sessionId, state); // No debounce for exit
  }

  getState(sessionId: string): SessionState {
    return this.states.get(sessionId) || 'starting';
  }

  private transition(sessionId: string, newState: SessionState): void {
    const currentState = this.states.get(sessionId);
    if (currentState === newState) return;

    // Debounce to prevent flicker
    this.clearTimer(this.debounceTimers, sessionId);
    this.debounceTimers.set(sessionId, setTimeout(() => {
      this.setState(sessionId, newState);
      this.debounceTimers.delete(sessionId);
    }, DEBOUNCE_MS));
  }

  private setState(sessionId: string, state: SessionState): void {
    const prev = this.states.get(sessionId);
    if (prev === state) return;
    this.states.set(sessionId, state);
    this.callback?.(sessionId, state);
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

  dispose(): void {
    for (const timer of this.waitingTimers.values()) clearTimeout(timer);
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.waitingTimers.clear();
    this.idleTimers.clear();
    this.debounceTimers.clear();
    this.states.clear();
    this.buffers.clear();
    this.cliTools.clear();
  }
}

export const statusDetector = new StatusDetector();
