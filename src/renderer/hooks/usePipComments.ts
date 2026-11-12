import { useEffect, useState } from 'react';
import { PIP_AI_EVENTS, type PipAiEvent, type PipCommentResult, type PipSettings } from '../../shared/pip';
import type { PipEvent } from '../lib/pip-behavior';

export interface PipMoment { event: PipEvent; variation: number; }
/** Delay before asking, so the CLI can append its submitted prompt to its transcript. */
export const PIP_AI_REQUEST_DELAY_MS = 600;

/**
 * Asks main for a quip about the current spoken moment. Main owns the cooldown and hourly limit and
 * answers with the reason when it declines, so the renderer keeps no limit of its own. A moment that
 * ends before the request is sent never reaches main and so never counts as an attempt.
 */
export function usePipComments(moment: PipMoment | null, sessionId: string | null, active: boolean, settings: PipSettings) {
  const [reply, setReply] = useState<{ moment: PipMoment; sessionId: string | null; value: PipCommentResult } | null>(null);
  const [pending, setPending] = useState(false);
  const enabled = active && settings.aiComments && !settings.quiet;
  useEffect(() => {
    setReply(null);
    setPending(false);
    if (!enabled || !moment || !PIP_AI_EVENTS.includes(moment.event.kind as PipAiEvent)) return;
    let cancelled = false;
    let requested = false;
    const timer = setTimeout(() => {
      if (!window.electronAPI?.pip) return;
      requested = true;
      setPending(true);
      window.electronAPI.pip.comment({ event: moment.event.kind as PipAiEvent, sessionId }).then(value => {
        if (!cancelled) { setReply({ moment, sessionId, value }); setPending(false); }
      }).catch(() => {
        if (!cancelled) {
          setReply({ moment, sessionId, value: { status: 'unavailable', line: null, model: null, reason: 'AI comments unavailable. Using local quips.' } });
          setPending(false);
        }
      });
    }, PIP_AI_REQUEST_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (requested) void window.electronAPI?.pip?.cancelComment().catch(() => {});
    };
  }, [moment, sessionId, enabled, settings.personality, settings.sharePrompts]);
  const current = enabled && reply?.moment === moment && reply.sessionId === sessionId ? reply.value : null;
  return { line: current?.line ?? null, pending: enabled && pending, result: current };
}
