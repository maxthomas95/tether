import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import {
  PipObserver, PIP_COMMENT_COOLDOWN_MS, PIP_EXPRESSION_MS, PIP_NAP_DELAY_MS, PIP_SPEECH_MS, PIP_TIER_AMBIENT, PIP_TIER_URGENT,
  pipEventHolds, pipEventTier, pipPermissionPending, pipReaction, pipRestingMood, pipSessionLabel,
  type PipEvent, type PipEventTier, type PipMood, type PipReaction, type PipSession,
} from '../lib/pip-behavior';
import type { PipSettings } from '../lib/pip-settings';
import { onPipActivity } from '../lib/pip-activity';
import { usePipComments, type PipMoment } from './usePipComments';

/** A nap outranks typing, typing outranks a reaction, and a reaction outranks the resting mood. */
function pipFace(napping: boolean, typing: boolean, reaction: PipReaction | null, resting: PipMood): { mood: PipMood; emote: string } {
  if (napping) return { mood: 'sleepy', emote: 'z z' };
  if (typing) return { mood: 'typing', emote: '⌨' };
  if (reaction) return { mood: reaction.mood, emote: reaction.emote };
  return { mood: resting, emote: resting === 'permission' ? '?' : '' };
}

/** Pip's pupils follow the pointer while motion is allowed. */
function usePipGaze(panelRef: RefObject<HTMLElement | null>, motionAllowed: boolean) {
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const reset = () => {
      panel.style.setProperty('--pip-gaze-x', '0px');
      panel.style.setProperty('--pip-gaze-y', '0px');
    };
    reset();
    if (!motionAllowed) return;
    // Pointer moves only record where to look. The layout read and the style
    // write happen at most once per frame.
    const button = panel.querySelector('.pip-pet-button');
    let frame = 0;
    let pointerX = 0;
    let pointerY = 0;
    const look = () => {
      frame = 0;
      const bounds = button?.getBoundingClientRect();
      if (!bounds) return;
      const x = Math.max(-3, Math.min(3, (pointerX - bounds.left - bounds.width / 2) / 45));
      const y = Math.max(-2, Math.min(2, (pointerY - bounds.top - bounds.height / 2) / 55));
      panel.style.setProperty('--pip-gaze-x', `${x}px`);
      panel.style.setProperty('--pip-gaze-y', `${y}px`);
    };
    const gaze = (event: PointerEvent) => {
      pointerX = event.clientX;
      pointerY = event.clientY;
      if (!frame) frame = requestAnimationFrame(look);
    };
    const leave = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      reset();
    };
    document.addEventListener('pointermove', gaze, { passive: true });
    document.addEventListener('pointerleave', leave);
    return () => {
      document.removeEventListener('pointermove', gaze);
      document.removeEventListener('pointerleave', leave);
      leave();
    };
  }, [motionAllowed]);
}

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
    const stop = onPipActivity(activity => {
      if (activity.sessionId !== activeSessionId) return;
      clearTimeout(timer);
      if (activity.submitted) {
        setTyping(false);
        showEvent({ kind: 'submitted', label: '' });
      } else {
        setTyping(true);
        timer = setTimeout(() => setTyping(false), 1200);
      }
    });
    return () => { clearTimeout(timer); stop(); };
  }, [active, activeSessionId, showEvent]);

  useEffect(() => {
    if (!active) return;
    // One timer for the whole idle period. Activity only records a timestamp,
    // so a moving pointer does not cancel and re-create a timer per event.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastActivity = Date.now();
    const nap = () => {
      const idle = Date.now() - lastActivity;
      if (idle < PIP_NAP_DELAY_MS) {
        timer = setTimeout(nap, PIP_NAP_DELAY_MS - idle);
        return;
      }
      timer = undefined;
      sleeping.current = true;
      setNapping(true);
      showEvent({ kind: 'nap', label: '' });
    };
    const wake = () => {
      lastActivity = Date.now();
      if (sleeping.current) {
        sleeping.current = false;
        setNapping(false);
        setExpression(moment => moment?.event.kind === 'nap' ? null : moment);
        setSpeech(moment => moment?.event.kind === 'nap' ? null : moment);
      }
      // No nap while a permission prompt is pending; the timer restarts when it clears.
      if (timer === undefined && !permissionPending) timer = setTimeout(nap, PIP_NAP_DELAY_MS);
    };
    rouse.current = wake;
    wake();
    const stopActivity = onPipActivity(activity => { if (activity.sessionId === activeSessionId) wake(); });
    document.addEventListener('pointermove', wake, { passive: true });
    document.addEventListener('pointerdown', wake, { passive: true });
    document.addEventListener('keydown', wake);
    document.addEventListener('wheel', wake, { passive: true });
    return () => {
      clearTimeout(timer);
      rouse.current = () => {};
      stopActivity();
      document.removeEventListener('pointermove', wake);
      document.removeEventListener('pointerdown', wake);
      document.removeEventListener('keydown', wake);
      document.removeEventListener('wheel', wake);
    };
  }, [active, activeSessionId, showEvent, permissionPending]);

  usePipGaze(panelRef, motionAllowed);

  const reaction = expression ? pipReaction(expression.event, settings.personality, expression.variation) : null;
  const { mood, emote } = pipFace(napping, typing, reaction, pipRestingMood(sessions, activeSessionId));
  const greeting = settings.personality === 'dry' ? 'I supervise. You do the keyboard stuff.' : 'Your tiny coding buddy. Happy to be here.';
  const spokenLine = speech ? pipReaction(speech.event, settings.personality, speech.variation).line : greeting;
  const line = settings.quiet ? 'Quiet company. Same tiny supervisor.' : comments.line ?? spokenLine;
  // Screen readers hear only the lines about a session that needs the person, in Pip's own words.
  const announcement = speech && !settings.quiet && pipEventTier(speech.event.kind) === PIP_TIER_URGENT ? spokenLine : '';

  return {
    panelRef, active, motionAllowed, mood, line, announcement, comments,
    emote,
    following: session ? `Following ${pipSessionLabel(session)}` : 'Keeping you company',
    pet: () => { sleeping.current = false; setNapping(false); showEvent({ kind: 'pet', label: '' }, true); },
  };
}
