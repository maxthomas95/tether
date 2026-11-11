/**
 * Width bounds of the docked subagent panel. The drag handle clamps to them
 * and the stylesheet caps the panel at a share of the window on top, so the
 * terminal always keeps room.
 */
export const CHILD_AGENT_PANEL_MIN_WIDTH = 280;
export const CHILD_AGENT_PANEL_MAX_WIDTH = 720;
export const CHILD_AGENT_PANEL_DEFAULT_WIDTH = 400;
/** One arrow-key press on the focused handle. */
export const CHILD_AGENT_PANEL_KEY_STEP = 24;

/** Config key holding a width the user chose by dragging. */
export const CHILD_AGENT_PANEL_WIDTH_CONFIG_KEY = 'childAgentPanelWidth';

export function clampChildAgentPanelWidth(width: number): number {
  return Math.max(CHILD_AGENT_PANEL_MIN_WIDTH, Math.min(CHILD_AGENT_PANEL_MAX_WIDTH, Math.round(width)));
}

/** A saved width, clamped; null when nothing usable was saved. */
export function parseSavedChildAgentPanelWidth(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const width = Number(value);
  return Number.isFinite(width) ? clampChildAgentPanelWidth(width) : null;
}

/** A task longer than this starts folded, so the activity below it stays in view. */
const LONG_TASK_CHARS = 600;
const LONG_TASK_LINES = 8;

export function isLongTask(prompt: string): boolean {
  return prompt.length > LONG_TASK_CHARS || prompt.split('\n').length > LONG_TASK_LINES;
}
