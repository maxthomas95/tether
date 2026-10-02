import { useEffect, useRef, useState } from 'react';
import { PIP_AI_COOLDOWN_MS, PIP_AI_EVENTS, type PipAiEvent, type PipCommentResult, type PipSettings } from '../../shared/pip';
import type { PipEvent } from '../lib/pip-behavior';

export interface PipMoment { event: PipEvent; variation: number; }
export function usePipComments(moment: PipMoment | null, sessionId: string | null, active: boolean, settings: PipSettings) {
  const lastRequest = useRef(-Infinity);
  const [reply, setReply] = useState<{ moment: PipMoment; sessionId: string | null; value: PipCommentResult } | null>(null);
  const [pending, setPending] = useState(false);
  const enabled = active && settings.aiComments && !settings.quiet;
  useEffect(() => {
    setReply(null);
    setPending(false);
    if (!enabled || !moment || !PIP_AI_EVENTS.includes(moment.event.kind as PipAiEvent)
      || Date.now() - lastRequest.current < PIP_AI_COOLDOWN_MS) return;
    let cancelled = false;
    let requested = false;
    // Give the CLI a moment to append its submitted prompt to its transcript.
    const timer = setTimeout(() => {
      if (!window.electronAPI?.pip) return;
      requested = true;
      lastRequest.current = Date.now();
      setPending(true);
      window.electronAPI.pip.comment({ event: moment.event.kind as PipAiEvent, sessionId }).then(value => {
        if (!cancelled) { setReply({ moment, sessionId, value }); setPending(false); }
      }).catch(() => {
        if (!cancelled) {
          setReply({ moment, sessionId, value: { status: 'unavailable', line: null, model: null, reason: 'AI comments unavailable. Using local quips.' } });
          setPending(false);
        }
      });
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (requested) void window.electronAPI?.pip?.cancelComment().catch(() => {});
    };
  }, [moment, sessionId, enabled, settings.personality, settings.sharePrompts]);
  const current = enabled && reply?.moment === moment && reply.sessionId === sessionId ? reply.value : null;
  return { line: current?.line ?? null, pending: enabled && pending, result: current };
}
