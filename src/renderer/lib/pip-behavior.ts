import type { SessionInfo } from '../../shared/types';
import type { PipSettings } from './pip-settings';
import { PIP_LINES, type PipEventKind } from './pip-lines';

export type { PipEventKind } from './pip-lines';

export type PipSession = Pick<SessionInfo, 'id' | 'label' | 'workingDir' | 'state' | 'waitingReason'>;
export type PipMood = 'curious' | 'busy' | 'permission' | 'waiting' | 'happy' | 'sleepy' | 'dizzy' | 'concerned' | 'typing';
/** `sessionId` names the session a line is about, so the line can be retired once it stops being true. */
export interface PipEvent {
  kind: PipEventKind;
  label: string;
  sessionId?: string;
  /** Whole minutes of a long turn. */
  minutes?: number;
}
export interface PipReaction { mood: PipMood; emote: string; line: string; }

export const PIP_COMMENT_COOLDOWN_MS = 25000;
export const PIP_NAP_DELAY_MS = 90000;
export const PIP_EXPRESSION_MS = 6000;
export const PIP_SPEECH_MS = 12000;
/** A turn at least this long gets its own reaction when the agent hands back. */
export const PIP_LONG_TURN_MS = 5 * 60_000;

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
  return kind === 'ready' || kind === 'longTurn' || kind === 'stopped' || kind === 'crashed' ? PIP_TIER_NOTABLE : PIP_TIER_AMBIENT;
}

function isWorking(session: PipSession): boolean {
  return session.state === 'starting' || session.state === 'running';
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
  if (isWorking(session)) return 'busy';
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
  longTurn: { mood: 'happy', emote: '✧' }, crashed: { mood: 'concerned', emote: '!' }, delegated: { mood: 'busy', emote: '+' },
};

/** `variation` is how many lines of this kind have been spoken, so each kind walks its own list. */
export function pipReaction(event: PipEvent, personality: PipSettings['personality'], variation = 0): PipReaction {
  const lines = PIP_LINES[personality][event.kind];
  const line = lines[variation % lines.length].replaceAll('{session}', event.label).replaceAll('{minutes}', String(event.minutes ?? 0));
  return { ...EVENT_EXPRESSIONS[event.kind], line };
}

type PipStateEventKind = 'permission' | 'ready' | 'working' | 'idle' | 'stopped' | 'crashed';

function stateEventKind(session: PipSession): PipStateEventKind {
  switch (session.state) {
    case 'waiting': return waitsOnPermission(session) ? 'permission' : 'ready';
    case 'starting':
    case 'running': return 'working';
    case 'idle': return 'idle';
    case 'dead': return 'crashed';
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
    case 'longTurn': return !!subject && subject.id === activeId && stateEventKind(subject) === 'ready';
    case 'delegated': return !!subject && subject.id === activeId && isWorking(subject);
    case 'working':
    case 'permission':
    case 'ready':
    case 'idle':
    case 'stopped':
    case 'crashed': return !!subject && subject.id === activeId && stateEventKind(subject) === event.kind;
    default: return true;
  }
}

function enteredWaiting(session: PipSession, previous?: PipSession): boolean {
  return session.state === 'waiting' && !!previous &&
    (previous.state !== 'waiting' || (waitsOnPermission(session) && !waitsOnPermission(previous)));
}

const NO_CHILDREN: ReadonlyMap<string, number> = new Map();

/** Observes metadata only. Seeding prevents replaying events after a hidden panel resumes. */
export class PipObserver {
  private previous = new Map<string, PipSession>();
  private children: ReadonlyMap<string, number> = NO_CHILDREN;
  private readonly turnStarts = new Map<string, number>();
  private activeId: string | null = null;
  private switches: number[] = [];

  /** `children` is the number of running child agents per session id. */
  seed(sessions: readonly PipSession[], activeId: string | null, children: ReadonlyMap<string, number> = NO_CHILDREN) {
    this.remember(sessions, activeId, children);
    // A turn already under way was not seen starting, so its length is unknown.
    this.turnStarts.clear();
    this.switches = [];
  }

  private remember(sessions: readonly PipSession[], activeId: string | null, children: ReadonlyMap<string, number>) {
    // Copy only the values we observe; never retain mutable session objects.
    this.previous = new Map(sessions.map(({ id, label, workingDir, state, waitingReason }) =>
      [id, { id, label, workingDir, state, waitingReason }]));
    this.children = new Map(children);
    this.activeId = activeId;
  }

  /**
   * Follows each turn from the moment it is seen starting and returns the length
   * of every turn that just ended. A permission wait is part of the turn.
   */
  private trackTurns(sessions: readonly PipSession[], previous: ReadonlyMap<string, PipSession>, now: number): Map<string, number> {
    const ended = new Map<string, number>();
    const live = new Set<string>();
    for (const session of sessions) {
      live.add(session.id);
      const started = this.turnStarts.get(session.id);
      if (isWorking(session)) {
        if (started === undefined && seenStarting(session, previous.get(session.id))) this.turnStarts.set(session.id, now);
      } else if (!waitsOnPermission(session) && started !== undefined) {
        ended.set(session.id, now - started);
        this.turnStarts.delete(session.id);
      }
    }
    for (const id of Array.from(this.turnStarts.keys())) {
      if (!live.has(id)) this.turnStarts.delete(id);
    }
    return ended;
  }

  private focusEvent(active: PipSession, oldActiveId: string | null, now: number): PipEvent {
    if (oldActiveId) this.switches.push(now);
    const label = pipSessionLabel(active);
    if (this.switches.length >= 4) return { kind: 'dizzy', label };
    return { kind: waitsOnPermission(active) ? 'permission' : 'switch', label, sessionId: active.id };
  }

  private stateChange(active: PipSession, old: PipSession | undefined, turnMs: number | undefined): PipEvent | null {
    const kind = stateEvent(active, old);
    if (!kind) return null;
    const label = pipSessionLabel(active);
    if (kind === 'ready' && turnMs !== undefined && turnMs >= PIP_LONG_TURN_MS) {
      return { kind: 'longTurn', label, sessionId: active.id, minutes: Math.floor(turnMs / 60_000) };
    }
    return { kind, label, sessionId: active.id };
  }

  observe(sessions: readonly PipSession[], activeId: string | null, now: number, children: ReadonlyMap<string, number> = NO_CHILDREN): PipEvent | null {
    const previous = this.previous;
    const previousChildren = this.children;
    const oldActiveId = this.activeId;
    this.switches = this.switches.filter(time => now - time < 6000);
    this.remember(sessions, activeId, children);
    const ended = this.trackTurns(sessions, previous, now);
    const active = sessions.find(session => session.id === activeId);
    if (!active) return backgroundWait(sessions, activeId, previous);
    if (oldActiveId !== activeId) return this.focusEvent(active, oldActiveId, now);
    const old = previous.get(active.id);
    const change = this.stateChange(active, old, ended.get(active.id));
    if (change) return change;
    const waiting = backgroundWait(sessions, activeId, previous);
    if (waiting) return waiting;
    // Helpers appearing under the focused session, when it had none a moment ago.
    const gainedHelpers = (children.get(active.id) ?? 0) > 0 && (previousChildren.get(active.id) ?? 0) === 0;
    return old && isWorking(active) && gainedHelpers ? { kind: 'delegated', label: pipSessionLabel(active), sessionId: active.id } : null;
  }
}

/** A turn counts from a start Pip saw: a session leaving a rest state, or a new session launching. */
function seenStarting(session: PipSession, before: PipSession | undefined): boolean {
  if (!before) return session.state === 'starting';
  return !isWorking(before) && !waitsOnPermission(before);
}

function backgroundWait(sessions: readonly PipSession[], activeId: string | null, previous: ReadonlyMap<string, PipSession>): PipEvent | null {
  const newlyWaiting = sessions.find(session => session.id !== activeId && enteredWaiting(session, previous.get(session.id)));
  return newlyWaiting ? { kind: 'attention', label: pipSessionLabel(newlyWaiting), sessionId: newlyWaiting.id } : null;
}
