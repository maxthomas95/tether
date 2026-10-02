export const PIP_ACTIVITY_EVENT = 'tether:pip-input';
export interface PipActivity { sessionId: string; submitted: boolean; }

/** A local activity signal; the input bytes are never copied into the event. */
export function reportPipActivity(sessionId: string, submitted = false): void {
  document.dispatchEvent(new CustomEvent<PipActivity>(PIP_ACTIVITY_EVENT, { detail: { sessionId, submitted } }));
}
