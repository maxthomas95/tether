import type { PipAiBackend, PipAiEvent, PipBackendStatus, PipCommentResult, PipSettings } from '../../../shared/pip';

export interface PipBackendRequest {
  /** Tether's neutral app folder. Never the user's project. */
  cwd: string;
  event: PipAiEvent;
  personality: PipSettings['personality'];
  /** A scrubbed prompt excerpt, present only with prompt-sharing consent for this backend. */
  prompt: string | null;
}

/** A CLI sign-in that can write one quip. Backends never run tools, never fall back to a larger model, and leave no saved session. */
export interface PipCommentBackend {
  id: PipAiBackend;
  generate(request: PipBackendRequest, signal: AbortSignal): Promise<PipCommentResult>;
  /** Sign-in and model check, run when the backend is chosen. Makes no model request. */
  status(cwd: string, signal: AbortSignal): Promise<PipBackendStatus>;
}
