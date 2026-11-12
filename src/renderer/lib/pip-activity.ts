export interface PipActivity { sessionId: string; submitted: boolean; }
type PipActivityListener = (activity: PipActivity) => void;

const listeners = new Set<PipActivityListener>();

/** Pip listens only while it is showing, so a hidden or disabled Pip costs a keystroke nothing. */
export function onPipActivity(listener: PipActivityListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** A local activity signal; the input bytes are never copied into it. */
export function reportPipActivity(sessionId: string, submitted = false): void {
  if (listeners.size === 0) return;
  const activity: PipActivity = { sessionId, submitted };
  for (const listener of Array.from(listeners)) listener(activity);
}

const ESCAPE = 0x1b;
const BRACKETED_PASTE_START = '\x1b[200~';

/**
 * Whether terminal input that arrived without a key event is text from the
 * person. xterm also sends focus reports, replies to terminal queries and mouse
 * reports through the same callback, and every one of those starts with ESC.
 * Pasted or composed text does not, apart from a bracketed paste. Only the
 * leading characters are compared and nothing is kept.
 */
export function isTypedText(data: string): boolean {
  return data.length > 0 && (data.charCodeAt(0) !== ESCAPE || data.startsWith(BRACKETED_PASTE_START));
}
