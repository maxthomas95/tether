import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PipObserver, PIP_COMMENT_COOLDOWN_MS, PIP_EXPRESSION_MS, PIP_NAP_DELAY_MS, PIP_SPEECH_MS, PIP_TIER_AMBIENT, PIP_TIER_URGENT,
  pipEventHolds, pipEventTier, pipPermissionPending, pipReaction, pipRestingMood, pipSessionLabel,
  type PipEvent, type PipEventTier, type PipSession,
} from '../lib/pip-behavior';
import type { PipSettings } from '../lib/pip-settings';
import { PIP_ACTIVITY_EVENT, type PipActivity } from '../lib/pip-activity';
import { usePipComments, type PipMoment } from './usePipComments';

export function usePip(sessions: readonly PipSession[], activeSessionId: string | null, settings: PipSettings) {
  const panelRef = useRef<HTMLElement>(null);
  const observer = useRef(new PipObserver());
  const wasActive = useRef(false);
  const lastComment = useRef(-Infinity);
  const lastTier = useRef<PipEventTier>(PIP_TIER_AMBIENT);
  const rouse = useRef<() => void>(() => {});
  const variation = useRef(0);
  const [visible, setVisible] = useState(!document.hidden);
  const [reducedMotion, setReducedMotion] = useState(() => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  const [expression, setExpression] = useState<PipMoment | null>(null);
  const [speech, setSpeech] = useState<PipMoment | null>(null);
  const [typing, setTyping] = useState(false);
  const [napping, setNapping] = useState(false);
  const sleeping = useRef(false);
  const active = settings.enabled && !settings.collapsed && visible;
  const motionAllowed = active && settings.motion && !reducedMotion;
  const session = sessions.find(item => item.id === activeSessionId);
  const permissionPending = pipPermissionPending(sessions);
  const comments = usePipComments(speech, activeSessionId, active, settings);

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
    const tier = pipEventTier(event.kind);
    const moment = { event, variation: variation.current };
    // A session that needs the person outranks a nap.
    if (tier === PIP_TIER_URGENT) rouse.current();
    setExpression(moment);
    if (settings.quiet) {
      setSpeech(null);
      return;
    }
    // Inside the cooldown a line yields only to a more important one, and a
    // line that is not replaced stays for its own lifetime instead of blanking.
    const cooled = now - lastComment.current >= PIP_COMMENT_COOLDOWN_MS;
    if (!force && tier !== PIP_TIER_URGENT && !cooled && tier <= lastTier.current) return;
    setSpeech(moment);
    lastComment.current = now;
    lastTier.current = tier;
    variation.current += 1;
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
    // Retire a line once the state it describes has ended.
    setSpeech(moment => moment && !pipEventHolds(moment.event, sessions, activeSessionId) ? null : moment);
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
    setTyping(false);
    if (!active || !activeSessionId) return;
    let timer: ReturnType<typeof setTimeout>;
    const input = (event: Event) => {
      const detail = (event as CustomEvent<PipActivity>).detail;
      if (detail?.sessionId !== activeSessionId) return;
      sleeping.current = false;
      setNapping(false);
      clearTimeout(timer);
      if (detail.submitted) {
        setTyping(false);
        showEvent({ kind: 'submitted', label: '' });
      } else {
        setTyping(true);
        timer = setTimeout(() => setTyping(false), 1200);
      }
    };
    document.addEventListener(PIP_ACTIVITY_EVENT, input);
    return () => { clearTimeout(timer); document.removeEventListener(PIP_ACTIVITY_EVENT, input); };
  }, [active, activeSessionId, showEvent]);

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
      // No nap while a permission prompt is pending; the timer restarts when it clears.
      if (permissionPending) return;
      timer = setTimeout(() => {
        sleeping.current = true;
        setNapping(true);
        showEvent({ kind: 'nap', label: '' });
      }, PIP_NAP_DELAY_MS);
    };
    const inputWake = (event: Event) => {
      if ((event as CustomEvent<PipActivity>).detail?.sessionId === activeSessionId) wake();
    };
    rouse.current = wake;
    wake();
    document.addEventListener('pointermove', wake, { passive: true });
    document.addEventListener('pointerdown', wake, { passive: true });
    document.addEventListener('keydown', wake);
    document.addEventListener(PIP_ACTIVITY_EVENT, inputWake);
    document.addEventListener('wheel', wake, { passive: true });
    return () => {
      clearTimeout(timer);
      rouse.current = () => {};
      document.removeEventListener('pointermove', wake);
      document.removeEventListener('pointerdown', wake);
      document.removeEventListener('keydown', wake);
      document.removeEventListener(PIP_ACTIVITY_EVENT, inputWake);
      document.removeEventListener('wheel', wake);
    };
  }, [active, activeSessionId, showEvent, permissionPending]);

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
  const mood = napping ? 'sleepy' : typing ? 'typing' : reaction?.mood ?? pipRestingMood(sessions, activeSessionId);
  const greeting = settings.personality === 'dry' ? 'I supervise. You do the keyboard stuff.' : 'Your tiny coding buddy. Happy to be here.';
  const spokenLine = speech ? pipReaction(speech.event, settings.personality, speech.variation).line : greeting;
  const line = settings.quiet ? 'Quiet company. Same tiny supervisor.' : comments.line ?? spokenLine;
  const idleEmote = mood === 'permission' ? '?' : '';
  const emote = napping ? 'z z' : typing ? '⌨' : reaction?.emote ?? idleEmote;

  return {
    panelRef, active, motionAllowed, mood, line, comments,
    emote,
    following: session ? `Following ${pipSessionLabel(session)}` : 'Keeping you company',
    pet: () => { sleeping.current = false; setNapping(false); showEvent({ kind: 'pet', label: '' }, true); },
  };
}
