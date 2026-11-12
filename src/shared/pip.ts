export interface PipSettings {
  enabled: boolean;
  collapsed: boolean;
  quiet: boolean;
  motion: boolean;
  personality: 'dry' | 'sweet';
  aiComments: boolean;
  sharePrompts: boolean;
  /** Mention Vault expiry, quota, budget and updates that the sidebar already shows. */
  nudges: boolean;
}

export const PIP_SETTINGS_KEY = 'sidebarPet';
export const DEFAULT_PIP_SETTINGS: PipSettings = {
  enabled: false, collapsed: false, quiet: false, motion: true, personality: 'dry', aiComments: false, sharePrompts: false, nudges: false,
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
      sharePrompts: saved.sharePrompts === true,
      nudges: saved.nudges === true,
    };
  } catch {
    return { ...DEFAULT_PIP_SETTINGS };
  }
}

export const PIP_AI_COOLDOWN_MS = 120_000;
export const PIP_AI_HOURLY_LIMIT = 12;
/**
 * Events that may ask for an AI quip. `longTurn` is the only PR 3 reaction here: crashes are not
 * joke material, helpers joining is frequent, and nudges stay local by design.
 */
export const PIP_AI_EVENTS = ['working', 'permission', 'ready', 'longTurn', 'stopped', 'attention', 'submitted', 'dizzy'] as const;
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
};
/** Deliberately contains no keystrokes, prompts, labels, paths, or terminal output. */
export interface PipCommentRequest { event: PipAiEvent; sessionId: string | null; }
export interface PipCommentResult {
  status: 'ready' | 'unavailable' | 'paused';
  line: string | null;
  model: string | null;
  reason: string | null;
}
