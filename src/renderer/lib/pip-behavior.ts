import type { SessionInfo } from '../../shared/types';
import type { PipSettings } from './pip-settings';

export type PipSession = Pick<SessionInfo, 'id' | 'label' | 'workingDir' | 'state' | 'waitingReason'>;
export type PipMood = 'curious' | 'busy' | 'permission' | 'waiting' | 'happy' | 'sleepy' | 'dizzy' | 'concerned';
export type PipEventKind = 'switch' | 'dizzy' | 'working' | 'permission' | 'ready' | 'idle' | 'stopped' | 'attention' | 'pet' | 'nap';
export interface PipEvent { kind: PipEventKind; label: string; }
export interface PipReaction { mood: PipMood; emote: string; line: string; }

export const PIP_COMMENT_COOLDOWN_MS = 25000;
export const PIP_NAP_DELAY_MS = 90000;
export const PIP_EXPRESSION_MS = 6000;
export const PIP_SPEECH_MS = 12000;

export function pipSessionLabel(session?: PipSession): string {
  return session?.label || session?.workingDir.split(/[\\/]/).filter(Boolean).at(-1) || 'your sessions';
}

export function pipSessionMood(session?: PipSession): PipMood {
  if (!session) return 'curious';
  if (session.state === 'starting' || session.state === 'running') return 'busy';
  if (session.state === 'waiting') return session.waitingReason === 'permission' ? 'permission' : 'waiting';
  if (session.state === 'idle') return 'sleepy';
  return 'concerned';
}

export const PIP_MOOD_LABELS: Record<PipMood, string> = {
  curious: 'Keeping you company', busy: 'Supervising', permission: 'Waiting with you',
  waiting: 'Ready when you are', happy: 'Very pleased', sleepy: 'On nap duty',
  dizzy: 'Catching up', concerned: 'Checking in',
};

const EVENT_EXPRESSIONS: Record<PipEventKind, { mood: PipMood; emote: string }> = {
  switch: { mood: 'curious', emote: '' }, dizzy: { mood: 'dizzy', emote: '?!' },
  working: { mood: 'busy', emote: '···' }, permission: { mood: 'permission', emote: '?' },
  ready: { mood: 'happy', emote: '✧' }, idle: { mood: 'sleepy', emote: 'z z' },
  stopped: { mood: 'concerned', emote: '?' }, attention: { mood: 'permission', emote: '?' },
  pet: { mood: 'happy', emote: '♥' }, nap: { mood: 'sleepy', emote: 'z z' },
};

const LINES: Record<PipSettings['personality'], Record<PipEventKind, readonly string[]>> = {
  dry: {
    switch: ['Ah, {session}. My other office.', 'New session. Same excellent supervisor.', 'I followed you. Very professional of me.'],
    dizzy: ['Are we coding or speed-dating repositories?', 'So many tabs. So few paws.'],
    working: ["They're thinking. I'm also thinking. About snacks.", 'Excellent. Someone around here is working.', 'My contribution is moral support and fur.'],
    permission: ["Permission slip, please. I don't have thumbs.", 'Your agent has a question. I have several.', "Someone needs the human. That's you, apparently."],
    ready: ["They're ready for you. I'm ready for snacks.", 'Your agent is waiting. My supervision is impeccable.', 'The keyboard needs its human again.'],
    idle: ["I'll guard the sidebar. From inside this nap.", 'Scheduled maintenance: tiny nap.'],
    stopped: ['This session has stopped. My shift apparently continues.', 'Agent offline. Cat still online.'],
    attention: ['{session} needs you. I would go, but no thumbs.', 'A question from {session}. I delegated it to you.'],
    pet: ['Finally. My performance review.', 'Compensation received. Continue.', 'I accept payment in this exact format.'],
    nap: ['Wake me when the humans return.', "I'll guard the sidebar. From inside this nap.", 'Scheduled maintenance: tiny nap.'],
  },
  sweet: {
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

function stateEvent(active?: PipSession, previous?: PipSession): PipEventKind | null {
  if (!active || !previous || (previous.state === active.state && previous.waitingReason === active.waitingReason)) return null;
  switch (active.state) {
    case 'waiting': return active.waitingReason === 'permission' ? 'permission' : 'ready';
    case 'starting':
    case 'running': return 'working';
    case 'idle': return 'idle';
    default: return 'stopped';
  }
}

function enteredWaiting(session: PipSession, previous?: PipSession): boolean {
  return session.state === 'waiting' && !!previous &&
    (previous.state !== 'waiting' || (session.waitingReason === 'permission' && previous.waitingReason !== 'permission'));
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
    return { kind: active.state === 'waiting' && active.waitingReason === 'permission' ? 'permission' : 'switch', label };
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
    if (kind) return { kind, label };
    const newlyWaiting = sessions.find(session => session.id !== activeId && enteredWaiting(session, previous.get(session.id)));
    return newlyWaiting ? { kind: 'attention', label: pipSessionLabel(newlyWaiting) } : null;
  }
}
