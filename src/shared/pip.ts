/** CLI whose sign-in makes AI quips. It decides which company receives the text, so it is always chosen explicitly. */
export type PipAiBackend = 'codex' | 'claude';
export const PIP_AI_BACKENDS: readonly PipAiBackend[] = ['codex', 'claude'];

export interface PipSettings {
  enabled: boolean;
  collapsed: boolean;
  quiet: boolean;
  motion: boolean;
  personality: 'dry' | 'sweet';
  aiComments: boolean;
  /** Kept when AI quips are turned off, so turning them back on restores the last choice. */
  aiBackend: PipAiBackend;
  sharePrompts: boolean;
  /** Mention Vault expiry, quota, budget and updates that the sidebar already shows. */
  nudges: boolean;
  /** Most AI quip requests in any rolling hour, including Try a quip. */
  aiHourlyLimit: number;
  /** Shortest wait between two automatic AI quips. */
  aiCooldownSeconds: number;
}

/** Bounds for the two AI limits. Main reads the saved value through `readPipSettings`, so these hold there too. */
export const PIP_AI_HOURLY_LIMIT_RANGE = { min: 1, max: 30, fallback: 12 } as const;
export const PIP_AI_COOLDOWN_SECONDS_RANGE = { min: 30, max: 1800, fallback: 120 } as const;

function boundedInteger(value: unknown, range: { min: number; max: number; fallback: number }): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return range.fallback;
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
}

export const PIP_SETTINGS_KEY = 'sidebarPet';
export const DEFAULT_PIP_SETTINGS: PipSettings = {
  enabled: false, collapsed: false, quiet: false, motion: true, personality: 'dry', aiComments: false, aiBackend: 'codex', sharePrompts: false, nudges: false,
  aiHourlyLimit: PIP_AI_HOURLY_LIMIT_RANGE.fallback, aiCooldownSeconds: PIP_AI_COOLDOWN_SECONDS_RANGE.fallback,
};

export function readPipSettings(raw: string | null): PipSettings {
  try {
    const value: unknown = JSON.parse(raw ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_PIP_SETTINGS };
    const saved = value as Record<string, unknown>;
    return {
      enabled: typeof saved.enabled === 'boolean' ? saved.enabled : false,
      collapsed: typeof saved.collapsed === 'boolean' ? saved.collapsed : false,
      quiet: typeof saved.quiet === 'boolean' ? saved.quiet : false,
      motion: typeof saved.motion === 'boolean' ? saved.motion : true,
      personality: saved.personality === 'sweet' ? 'sweet' : 'dry',
      aiComments: saved.aiComments === true,
      aiBackend: saved.aiBackend === 'claude' ? 'claude' : 'codex',
      sharePrompts: saved.sharePrompts === true,
      nudges: saved.nudges === true,
      aiHourlyLimit: boundedInteger(saved.aiHourlyLimit, PIP_AI_HOURLY_LIMIT_RANGE),
      aiCooldownSeconds: boundedInteger(saved.aiCooldownSeconds, PIP_AI_COOLDOWN_SECONDS_RANGE),
    };
  } catch {
    return { ...DEFAULT_PIP_SETTINGS };
  }
}

/**
 * Events that may ask for an AI quip. `longTurn` is the only PR 3 reaction here: crashes are not
 * joke material, helpers joining is frequent, and nudges stay local by design. `hello` comes only
 * from the **Try a quip** button.
 */
export const PIP_AI_EVENTS = ['working', 'permission', 'ready', 'longTurn', 'stopped', 'attention', 'submitted', 'dizzy', 'hello'] as const;
export type PipAiEvent = typeof PIP_AI_EVENTS[number];
/** Plain-language situations sent to a quip backend, so the model is not guessing at event ids. */
export const PIP_AI_SITUATIONS: Readonly<Record<PipAiEvent, string>> = {
  working: 'The coding agent started working.',
  permission: 'The coding agent is waiting for the person to approve a permission prompt.',
  ready: 'The coding agent finished its turn and is waiting for the person.',
  longTurn: 'The coding agent just finished a turn that took several minutes.',
  stopped: 'The session was stopped.',
  attention: 'A different session in the background needs the person.',
  submitted: 'The person just pressed Enter to send something to the agent.',
  dizzy: 'The person is switching between sessions very quickly.',
  hello: 'The person asked Pip to say something.',
};

/** Whether a backend can make quips right now, checked when it is chosen rather than at the next quip. */
export interface PipBackendStatus {
  backend: PipAiBackend;
  ready: boolean;
  /** Sign-in and model when ready, otherwise why not. Never includes account identifiers. */
  detail: string;
}
/** Deliberately contains no keystrokes, prompts, labels, paths, or terminal output. */
export interface PipCommentRequest { event: PipAiEvent; sessionId: string | null; }
export interface PipCommentResult {
  status: 'ready' | 'unavailable' | 'paused';
  line: string | null;
  model: string | null;
  reason: string | null;
}
