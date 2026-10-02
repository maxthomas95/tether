import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PipObserver, PIP_COMMENT_COOLDOWN_MS, PIP_EXPRESSION_MS, PIP_NAP_DELAY_MS, PIP_SPEECH_MS,
  pipReaction, pipSessionLabel, pipSessionMood, type PipEvent, type PipSession,
} from '../lib/pip-behavior';
import type { PipSettings } from '../lib/pip-settings';

interface Moment { event: PipEvent; variation: number; }

export function usePip(sessions: readonly PipSession[], activeSessionId: string | null, settings: PipSettings) {
  const panelRef = useRef<HTMLElement>(null);
  const observer = useRef(new PipObserver());
  const wasActive = useRef(false);
  const lastComment = useRef(-Infinity);
  const variation = useRef(0);
  const [visible, setVisible] = useState(!document.hidden);
  const [reducedMotion, setReducedMotion] = useState(() => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  const [expression, setExpression] = useState<Moment | null>(null);
  const [speech, setSpeech] = useState<Moment | null>(null);
  const [napping, setNapping] = useState(false);
  const sleeping = useRef(false);
  const active = settings.enabled && !settings.collapsed && visible;
  const motionAllowed = active && settings.motion && !reducedMotion;
  const session = sessions.find(item => item.id === activeSessionId);

  useEffect(() => {
    const visibility = () => setVisible(!document.hidden);
    const media = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
    const motion = () => setReducedMotion(media?.matches ?? false);
    document.addEventListener('visibilitychange', visibility);
    media?.addEventListener('change', motion);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      media?.removeEventListener('change', motion);
    };
  }, []);

  const showEvent = useCallback((event: PipEvent, force = false) => {
    const now = Date.now();
    const moment = { event, variation: variation.current };
    setExpression(moment);
    if (!settings.quiet && (force || now - lastComment.current >= PIP_COMMENT_COOLDOWN_MS)) {
      setSpeech(moment);
      lastComment.current = now;
      variation.current += 1;
    } else {
      setSpeech(null);
    }
  }, [settings.quiet]);

  useEffect(() => {
    if (!active || !wasActive.current) {
      observer.current.seed(sessions, activeSessionId);
      wasActive.current = active;
      setExpression(null);
      setSpeech(null);
      setNapping(false);
      sleeping.current = false;
      return;
    }
    const event = observer.current.observe(sessions, activeSessionId, Date.now());
    if (event) showEvent(event);
  }, [sessions, activeSessionId, active, showEvent]);

  useEffect(() => {
    if (!active || !expression) return;
    const timer = setTimeout(() => setExpression(null), PIP_EXPRESSION_MS);
    return () => clearTimeout(timer);
  }, [active, expression]);

  useEffect(() => {
    if (!active || !speech) return;
    const timer = setTimeout(() => setSpeech(null), PIP_SPEECH_MS);
    return () => clearTimeout(timer);
  }, [active, speech]);

  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout>;
    const wake = () => {
      if (sleeping.current) {
        sleeping.current = false;
        setNapping(false);
        setExpression(moment => moment?.event.kind === 'nap' ? null : moment);
        setSpeech(moment => moment?.event.kind === 'nap' ? null : moment);
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        sleeping.current = true;
        setNapping(true);
        showEvent({ kind: 'nap', label: '' });
      }, PIP_NAP_DELAY_MS);
    };
    wake();
    document.addEventListener('pointermove', wake, { passive: true });
    document.addEventListener('pointerdown', wake, { passive: true });
    document.addEventListener('keydown', wake);
    document.addEventListener('wheel', wake, { passive: true });
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointermove', wake);
      document.removeEventListener('pointerdown', wake);
      document.removeEventListener('keydown', wake);
      document.removeEventListener('wheel', wake);
    };
  }, [active, activeSessionId, showEvent]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const reset = () => {
      panel.style.setProperty('--pip-gaze-x', '0px');
      panel.style.setProperty('--pip-gaze-y', '0px');
    };
    reset();
    if (!motionAllowed) return;
    const gaze = (event: PointerEvent) => {
      const bounds = panel.querySelector('.pip-pet-button')?.getBoundingClientRect();
      if (!bounds) return;
      const x = Math.max(-3, Math.min(3, (event.clientX - bounds.left - bounds.width / 2) / 45));
      const y = Math.max(-2, Math.min(2, (event.clientY - bounds.top - bounds.height / 2) / 55));
      panel.style.setProperty('--pip-gaze-x', `${x}px`);
      panel.style.setProperty('--pip-gaze-y', `${y}px`);
    };
    document.addEventListener('pointermove', gaze, { passive: true });
    document.addEventListener('pointerleave', reset);
    return () => {
      document.removeEventListener('pointermove', gaze);
      document.removeEventListener('pointerleave', reset);
      reset();
    };
  }, [motionAllowed]);

  const reaction = expression ? pipReaction(expression.event, settings.personality, expression.variation) : null;
  const mood = napping ? 'sleepy' : reaction?.mood ?? pipSessionMood(session);
  const greeting = settings.personality === 'dry' ? 'I supervise. You do the keyboard stuff.' : 'Your tiny coding buddy. Happy to be here.';
  const line = settings.quiet ? 'Quiet company. Same tiny supervisor.' : speech
    ? pipReaction(speech.event, settings.personality, speech.variation).line : greeting;

  return {
    panelRef, active, motionAllowed, mood, line,
    emote: napping ? 'z z' : reaction?.emote ?? (mood === 'permission' ? '?' : ''),
    following: session ? `Following ${pipSessionLabel(session)}` : 'Keeping you company',
    pet: () => { sleeping.current = false; setNapping(false); showEvent({ kind: 'pet', label: '' }, true); },
  };
}
