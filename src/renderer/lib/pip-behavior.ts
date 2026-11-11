import type { SessionInfo } from '../../shared/types';
import type { PipSettings } from './pip-settings';

export type PipSession = Pick<SessionInfo, 'id' | 'label' | 'workingDir' | 'state' | 'waitingReason'>;
export type PipMood = 'curious' | 'busy' | 'permission' | 'waiting' | 'happy' | 'sleepy' | 'dizzy' | 'concerned' | 'typing';
export type PipEventKind = 'switch' | 'dizzy' | 'working' | 'permission' | 'ready' | 'idle' | 'stopped' | 'attention' | 'pet' | 'nap' | 'submitted';
/** `sessionId` names the session a line is about, so the line can be retired once it stops being true. */
export interface PipEvent { kind: PipEventKind; label: string; sessionId?: string; }
export interface PipReaction { mood: PipMood; emote: string; line: string; }

export const PIP_COMMENT_COOLDOWN_MS = 25000;
export const PIP_NAP_DELAY_MS = 90000;
export const PIP_EXPRESSION_MS = 6000;
export const PIP_SPEECH_MS = 12000;

export function pipSessionLabel(session?: PipSession): string {
  return session?.label || session?.workingDir.split(/[\\/]/).findLast(part => part.length > 0) || 'your sessions';
}

/** Ambient lines share one cooldown. A notable line may replace an ambient one. Urgent lines always speak. */
export const PIP_TIER_AMBIENT = 0;
export const PIP_TIER_NOTABLE = 1;
export const PIP_TIER_URGENT = 2;
export type PipEventTier = typeof PIP_TIER_AMBIENT | typeof PIP_TIER_NOTABLE | typeof PIP_TIER_URGENT;

export function pipEventTier(kind: PipEventKind): PipEventTier {
  if (kind === 'permission' || kind === 'attention') return PIP_TIER_URGENT;
  return kind === 'ready' || kind === 'stopped' ? PIP_TIER_NOTABLE : PIP_TIER_AMBIENT;
}

function waitsOnPermission(session: PipSession): boolean {
  return session.state === 'waiting' && session.waitingReason === 'permission';
}

/** True while any session, focused or not, is blocked on a permission prompt. */
export function pipPermissionPending(sessions: readonly PipSession[]): boolean {
  return sessions.some(waitsOnPermission);
}

export function pipSessionMood(session?: PipSession): PipMood {
  if (!session) return 'curious';
  if (session.state === 'starting' || session.state === 'running') return 'busy';
  if (session.state === 'waiting') return waitsOnPermission(session) ? 'permission' : 'waiting';
  if (session.state === 'idle') return 'sleepy';
  return 'concerned';
}

/** The focused session sets the resting mood, unless another session is blocked on a permission prompt. */
export function pipRestingMood(sessions: readonly PipSession[], activeId: string | null): PipMood {
  const mood = pipSessionMood(sessions.find(session => session.id === activeId));
  return mood !== 'permission' && pipPermissionPending(sessions) ? 'permission' : mood;
}

export const PIP_MOOD_LABELS: Record<PipMood, string> = {
  curious: 'Keeping you company', busy: 'Supervising', permission: 'Waiting with you',
  waiting: 'Ready when you are', happy: 'Very pleased', sleepy: 'On nap duty',
  dizzy: 'Catching up', concerned: 'Checking in',
  typing: 'Taking notes',
};

const EVENT_EXPRESSIONS: Record<PipEventKind, { mood: PipMood; emote: string }> = {
  submitted: { mood: 'curious', emote: '↵' },
  switch: { mood: 'curious', emote: '' }, dizzy: { mood: 'dizzy', emote: '?!' },
  working: { mood: 'busy', emote: '···' }, permission: { mood: 'permission', emote: '?' },
  ready: { mood: 'happy', emote: '✧' }, idle: { mood: 'sleepy', emote: 'z z' },
  stopped: { mood: 'concerned', emote: '?' }, attention: { mood: 'permission', emote: '?' },
  pet: { mood: 'happy', emote: '♥' }, nap: { mood: 'sleepy', emote: 'z z' },
};

const LINES: Record<PipSettings['personality'], Record<PipEventKind, readonly string[]>> = {
  dry: {
    submitted: ['Another idea launched into the void. Bold.', 'Enter pressed. Plausible deniability lost.', 'I would have typed that. If I had fingers.'],
    switch: ['Ah, {session}. My other office.', 'New session. Same excellent supervisor.', 'I followed you. Very professional of me.'],
    dizzy: ['Are we coding or speed-dating repositories?', 'So many tabs. So few paws.'],
    working: ["They're thinking. I'm also thinking. About snacks.", 'Excellent. Someone around here is working.', 'My contribution is moral support and cable management.'],
    permission: ["Permission slip, please. I don't have thumbs.", 'Your agent has a question. I have several.', "Someone needs the human. That's you, apparently."],
    ready: ["They're ready for you. I'm ready for snacks.", 'Your agent is waiting. My supervision is impeccable.', 'The keyboard needs its human again.'],
    idle: ["I'll guard the sidebar. From inside this nap.", 'Scheduled maintenance: tiny nap.'],
    stopped: ['This session has stopped. My shift apparently continues.', 'Agent offline. Gremlin still connected.'],
    attention: ['{session} needs you. I would go, but no thumbs.', 'A question from {session}. I delegated it to you.'],
    pet: ['Finally. My performance review.', 'Compensation received. Continue.', 'I accept payment in this exact format.'],
    nap: ['Wake me when the humans return.', "I'll guard the sidebar. From inside this nap.", 'Scheduled maintenance: tiny nap.'],
  },
  sweet: {
    submitted: ['Your next idea is on its way.', 'A little nudge toward the next adventure.', 'Sent! I will keep you company.'],
    switch: ['Off to {session}! Coming with you.', 'A new little adventure. I am here.', 'Your {session} buddy has arrived.'],
    dizzy: ['Lots of adventures today! Let me catch up.', 'Tiny paws. So many places to be.'],
    working: ["You've got this. I'll keep you company.", 'Little paws, big moral support.', 'Busy brains. Cozy company.'],
    permission: ['Your agent is waiting for a little help.', "A question for you! I'll wait here.", 'They need your okay before continuing.'],
    ready: ['Your agent is ready when you are.', 'Ready for the next little adventure.', 'A little pause for your next idea.'],
    idle: ['Rest is part of the work, too.', 'A little nap sounds lovely.'],
    stopped: ['This session has stopped. I am still here with you.', 'Your agent is offline. Your buddy is here.'],
    attention: ['{session} is waiting for a little help.', 'A question for you over in {session}.'],
    pet: ['You made my whole afternoon.', "Purr. That's the entire review.", 'Best part of being your coding buddy.'],
    nap: ['Rest is part of the work, too.', "I'll be right here when you get back.", 'A little nap sounds lovely.'],
  },
};

export function pipReaction(event: PipEvent, personality: PipSettings['personality'], variation = 0): PipReaction {
  const lines = LINES[personality][event.kind];
  return { ...EVENT_EXPRESSIONS[event.kind], line: lines[variation % lines.length].replaceAll('{session}', event.label) };
}

type PipStateEventKind = 'permission' | 'ready' | 'working' | 'idle' | 'stopped';

function stateEventKind(session: PipSession): PipStateEventKind {
  switch (session.state) {
    case 'waiting': return waitsOnPermission(session) ? 'permission' : 'ready';
    case 'starting':
    case 'running': return 'working';
    case 'idle': return 'idle';
    default: return 'stopped';
  }
}

function stateEvent(active?: PipSession, previous?: PipSession): PipStateEventKind | null {
  if (!active || !previous || (previous.state === active.state && previous.waitingReason === active.waitingReason)) return null;
  return stateEventKind(active);
}

/**
 * Whether a spoken line still describes the sessions. A line about a state ends
 * with that state, so Pip never keeps saying an agent is waiting after it resumed.
 */
export function pipEventHolds(event: PipEvent, sessions: readonly PipSession[], activeId: string | null): boolean {
  if (!event.sessionId) return true;
  const subject = sessions.find(session => session.id === event.sessionId);
  switch (event.kind) {
    case 'attention': return !!subject && subject.id !== activeId && subject.state === 'waiting';
    case 'switch': return event.sessionId === activeId;
    case 'working':
    case 'permission':
    case 'ready':
    case 'idle':
    case 'stopped': return !!subject && subject.id === activeId && stateEventKind(subject) === event.kind;
    default: return true;
  }
}

function enteredWaiting(session: PipSession, previous?: PipSession): boolean {
  return session.state === 'waiting' && !!previous &&
    (previous.state !== 'waiting' || (waitsOnPermission(session) && !waitsOnPermission(previous)));
}

/** Observes metadata only. Seeding prevents replaying events after a hidden panel resumes. */
export class PipObserver {
  private previous = new Map<string, PipSession>();
  private activeId: string | null = null;
  private switches: number[] = [];

  seed(sessions: readonly PipSession[], activeId: string | null) {
    // Copy only the values we observe; never retain mutable session objects.
    this.previous = new Map(sessions.map(({ id, label, workingDir, state, waitingReason }) =>
      [id, { id, label, workingDir, state, waitingReason }]));
    this.activeId = activeId;
    this.switches = [];
  }

  private focusEvent(active: PipSession, oldActiveId: string | null, now: number): PipEvent {
    if (oldActiveId) this.switches.push(now);
    const label = pipSessionLabel(active);
    if (this.switches.length >= 4) return { kind: 'dizzy', label };
    return { kind: waitsOnPermission(active) ? 'permission' : 'switch', label, sessionId: active.id };
  }

  observe(sessions: readonly PipSession[], activeId: string | null, now: number): PipEvent | null {
    const previous = this.previous;
    const oldActiveId = this.activeId;
    const switches = this.switches.filter(time => now - time < 6000);
    this.seed(sessions, activeId);
    this.switches = switches;
    const active = sessions.find(session => session.id === activeId);
    const label = pipSessionLabel(active);
    if (active && oldActiveId !== activeId) return this.focusEvent(active, oldActiveId, now);
    const old = active ? previous.get(active.id) : undefined;
    const kind = stateEvent(active, old);
    if (active && kind) return { kind, label, sessionId: active.id };
    const newlyWaiting = sessions.find(session => session.id !== activeId && enteredWaiting(session, previous.get(session.id)));
    return newlyWaiting ? { kind: 'attention', label: pipSessionLabel(newlyWaiting), sessionId: newlyWaiting.id } : null;
  }
}
