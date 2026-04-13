import type { CliToolId, SessionState } from '../../shared/types';

const RUNNING_TIMEOUT = 3000;   // No data for 3s after last output → check prompt
const IDLE_TIMEOUT = 30000;     // No data for 30s → idle
const DEBOUNCE_MS = 500;        // Debounce state transitions

// Heuristic prompt patterns (byte-level, not ANSI-parsed).
// These are the last few visible characters when a supported CLI shows input.
const CLAUDE_PROMPT_HINTS = [
  '> ',       // The standard prompt character
  '\u276f ',  // The "heavy right-pointing angle quotation mark" Claude uses
  '❯ ',       // Alternative prompt character
];

const PROMPT_HINTS: Record<CliToolId, string[]> = {
  claude: CLAUDE_PROMPT_HINTS,
  codex: [
    '> ',
    '\u203a ',
  ],
  opencode: ['> '],
  custom: ['> '],
};

export class StatusDetector {
  private states = new Map<string, SessionState>();
  private lastDataTime = new Map<string, number>();
  private lastChunk = new Map<string, string>();
  private cliTools = new Map<string, CliToolId>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
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
    this.lastDataTime.delete(sessionId);
    this.lastChunk.delete(sessionId);
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);
    const debounce = this.debounceTimers.get(sessionId);
    if (debounce) clearTimeout(debounce);
    this.debounceTimers.delete(sessionId);
  }

  // Called for every chunk of PTY output — this is the passive tap
  feedData(sessionId: string, data: string): void {
    const now = Date.now();
    this.lastDataTime.set(sessionId, now);
    this.lastChunk.set(sessionId, data);

    // Data is flowing → running
    this.transition(sessionId, 'running');

    // Reset the inactivity timer
    const existingTimer = this.timers.get(sessionId);
    if (existingTimer) clearTimeout(existingTimer);

    // After RUNNING_TIMEOUT of silence, check if prompt is showing
    this.timers.set(sessionId, setTimeout(() => {
      const lastChunk = this.lastChunk.get(sessionId) || '';
      if (this.looksLikePrompt(sessionId, lastChunk)) {
        this.transition(sessionId, 'waiting');
      }

      // After IDLE_TIMEOUT total silence, go idle
      this.timers.set(sessionId, setTimeout(() => {
        const currentState = this.states.get(sessionId);
        if (currentState === 'waiting' || currentState === 'running') {
          this.transition(sessionId, 'idle');
        }
      }, IDLE_TIMEOUT - RUNNING_TIMEOUT));
    }, RUNNING_TIMEOUT));
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
    const existing = this.debounceTimers.get(sessionId);
    if (existing) clearTimeout(existing);

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

  private looksLikePrompt(sessionId: string, chunk: string): boolean {
    // Strip ANSI escape sequences for matching
    const stripped = chunk.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    const lastLine = stripped.split('\n').pop()?.trim() || '';
    const cliTool = this.cliTools.get(sessionId) || 'claude';
    const hints = PROMPT_HINTS[cliTool] || PROMPT_HINTS.claude;
    return hints.some(hint => lastLine.endsWith(hint) || lastLine === hint.trim());
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.timers.clear();
    this.debounceTimers.clear();
    this.states.clear();
    this.lastDataTime.clear();
    this.lastChunk.clear();
    this.cliTools.clear();
  }
}

export const statusDetector = new StatusDetector();
