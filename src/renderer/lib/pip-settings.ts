export interface PipSettings {
  enabled: boolean;
  collapsed: boolean;
  quiet: boolean;
  motion: boolean;
  personality: 'dry' | 'sweet';
}

export const PIP_SETTINGS_KEY = 'sidebarPet';
export const DEFAULT_PIP_SETTINGS: PipSettings = {
  enabled: false, collapsed: false, quiet: false, motion: true, personality: 'dry',
};

/** Only known presentation preferences cross the existing config boundary. */
export function readPipSettings(raw: string | null): PipSettings {
  try {
    const value: unknown = JSON.parse(raw ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_PIP_SETTINGS };
    const saved = value as Record<string, unknown>;
    return {
      enabled: typeof saved.enabled === 'boolean' ? saved.enabled : DEFAULT_PIP_SETTINGS.enabled,
      collapsed: typeof saved.collapsed === 'boolean' ? saved.collapsed : DEFAULT_PIP_SETTINGS.collapsed,
      quiet: typeof saved.quiet === 'boolean' ? saved.quiet : DEFAULT_PIP_SETTINGS.quiet,
      motion: typeof saved.motion === 'boolean' ? saved.motion : DEFAULT_PIP_SETTINGS.motion,
      personality: saved.personality === 'sweet' ? 'sweet' : 'dry',
    };
  } catch {
    return { ...DEFAULT_PIP_SETTINGS };
  }
}
