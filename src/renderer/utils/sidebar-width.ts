/**
 * The one definition of the sidebar's width bounds. The drag handle clamps to
 * them and the sidebar element takes them as inline min/max width, so the
 * dragged value and the rendered width cannot disagree.
 */
export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 400;

/** Config key holding a width the user chose by dragging. */
export const SIDEBAR_WIDTH_CONFIG_KEY = 'sidebarWidth';

export function clampSidebarWidth(width: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.round(width)));
}

/** Width used until the user drags the handle; follows the interface density. */
export function defaultSidebarWidth(density: string): number {
  return density === 'compact' ? 220 : 260;
}

/** A saved width, clamped; null when nothing usable was saved. */
export function parseSavedSidebarWidth(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const width = Number(value);
  return Number.isFinite(width) ? clampSidebarWidth(width) : null;
}
