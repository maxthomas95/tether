export interface PipSettings {
  enabled: boolean;
  collapsed: boolean;
  quiet: boolean;
  motion: boolean;
  personality: 'dry' | 'sweet';
  aiComments: boolean;
  sharePrompts: boolean;
}

export const PIP_SETTINGS_KEY = 'sidebarPet';
export const DEFAULT_PIP_SETTINGS: PipSettings = {
  enabled: false, collapsed: false, quiet: false, motion: true, personality: 'dry', aiComments: false, sharePrompts: false,
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
    };
  } catch {
    return { ...DEFAULT_PIP_SETTINGS };
  }
}

export const PIP_AI_COOLDOWN_MS = 120_000;
export const PIP_AI_HOURLY_LIMIT = 12;
export const PIP_AI_EVENTS = ['working', 'permission', 'ready', 'stopped', 'attention', 'submitted', 'dizzy'] as const;
export type PipAiEvent = typeof PIP_AI_EVENTS[number];
/** Deliberately contains no keystrokes, prompts, labels, paths, or terminal output. */
export interface PipCommentRequest { event: PipAiEvent; sessionId: string | null; }
export interface PipCommentResult {
  status: 'ready' | 'unavailable' | 'paused';
  line: string | null;
  model: string | null;
  reason: string | null;
}
