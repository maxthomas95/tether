import { describe, expect, it } from 'vitest';
import {
  PIP_TIER_AMBIENT, PIP_TIER_NOTABLE, PIP_TIER_URGENT, PipObserver, pipEventHolds, pipEventTier, pipPermissionPending,
  pipReaction, pipRestingMood, pipSessionLabel, pipSessionMood, type PipEventKind, type PipSession,
} from './pip-behavior';
import { DEFAULT_PIP_SETTINGS, readPipSettings } from './pip-settings';

const session = (id: string, state: PipSession['state'] = 'running', waitingReason?: PipSession['waitingReason']): PipSession =>
  ({ id, label: id, workingDir: '/repo/' + id, state, waitingReason });

describe('Pip metadata observations', () => {
  it('seeds restored or newly visible sessions without replaying waits', () => {
    const observer = new PipObserver();
    const sessions = [session('a'), session('b', 'waiting', 'permission')];
    observer.seed(sessions, 'a');
    expect(observer.observe(sessions, 'a', 100)).toBeNull();
    observer.seed(sessions, 'b');
    expect(observer.observe(sessions, 'b', 200)).toBeNull();
  });

  it('follows focus, handles no pane, and gives permission waits priority', () => {
    const observer = new PipObserver();
    const sessions = [session('a'), session('b', 'waiting', 'permission')];
    observer.seed(sessions, 'a');
    expect(observer.observe(sessions, 'b', 100)).toEqual({ kind: 'permission', label: 'b', sessionId: 'b' });
    expect(observer.observe(sessions, null, 200)).toBeNull();
    expect(observer.observe(sessions, 'a', 300)).toEqual({ kind: 'switch', label: 'a', sessionId: 'a' });
  });

  it('gets dizzy after four real switches and ages old switches out', () => {
    const observer = new PipObserver();
    const sessions = [session('a'), session('b')];
    observer.seed(sessions, 'a');
    for (const [index, id] of ['b', 'a', 'b', 'a'].entries()) {
      expect(observer.observe(sessions, id, index * 500)?.kind).toBe(index === 3 ? 'dizzy' : 'switch');
    }
    expect(observer.observe(sessions, 'b', 10000)?.kind).toBe('switch');
  });

  it.each([
    ['starting', undefined, 'working'], ['running', undefined, 'working'],
    ['waiting', 'permission', 'permission'], ['waiting', 'idle', 'ready'],
    ['idle', undefined, 'idle'], ['stopped', undefined, 'stopped'], ['dead', undefined, 'stopped'],
  ] as const)('reacts to focused %s metadata', (state, reason, kind) => {
    const observer = new PipObserver();
    observer.seed([session('a', 'idle')], 'a');
    if (state === 'idle') observer.seed([session('a', 'running')], 'a');
    expect(observer.observe([session('a', state, reason)], 'a', 100)?.kind).toBe(kind);
    expect(observer.observe([session('a', state, reason)], 'a', 200)).toBeNull();
  });

  it('notices permission escalation even if the session stays waiting', () => {
    const observer = new PipObserver();
    observer.seed([session('a', 'waiting', 'idle')], 'a');
    expect(observer.observe([session('a', 'waiting', 'permission')], 'a', 100)?.kind).toBe('permission');
  });

  it('spots new background waits but does not treat new/restored sessions as transitions', () => {
    const observer = new PipObserver();
    observer.seed([session('a'), session('b')], 'a');
    expect(observer.observe([session('a'), session('b', 'waiting', 'idle')], 'a', 100)).toEqual({ kind: 'attention', label: 'b', sessionId: 'b' });
    expect(observer.observe([session('a'), session('b', 'waiting', 'permission')], 'a', 200)?.kind).toBe('attention');
    expect(observer.observe([session('a'), session('b', 'waiting', 'permission'), session('c', 'waiting')], 'a', 300)).toBeNull();
    expect(observer.observe([], null, 400)).toBeNull();
  });

  it('copies observed metadata so mutation cannot erase a transition', () => {
    const observer = new PipObserver();
    const mutable = session('a');
    observer.seed([mutable], 'a');
    mutable.state = 'waiting';
    expect(observer.observe([mutable], 'a', 100)?.kind).toBe('ready');
  });
});

describe('Pip attention rules', () => {
  it.each([
    ['permission', PIP_TIER_URGENT], ['attention', PIP_TIER_URGENT], ['ready', PIP_TIER_NOTABLE], ['stopped', PIP_TIER_NOTABLE],
    ['working', PIP_TIER_AMBIENT], ['switch', PIP_TIER_AMBIENT], ['submitted', PIP_TIER_AMBIENT], ['dizzy', PIP_TIER_AMBIENT],
    ['idle', PIP_TIER_AMBIENT], ['nap', PIP_TIER_AMBIENT], ['pet', PIP_TIER_AMBIENT],
  ] as const)('ranks %s events', (kind, tier) => expect(pipEventTier(kind)).toBe(tier));

  it('stays alert for a permission prompt in any session', () => {
    const blocked = [session('a'), session('b', 'waiting', 'permission')];
    expect(pipPermissionPending(blocked)).toBe(true);
    expect(pipRestingMood(blocked, 'a')).toBe('permission');
    expect(pipRestingMood(blocked, null)).toBe('permission');
    const ordinary = [session('a'), session('b', 'waiting', 'idle')];
    expect(pipPermissionPending(ordinary)).toBe(false);
    expect(pipRestingMood(ordinary, 'a')).toBe('busy');
    expect(pipRestingMood(ordinary, 'b')).toBe('waiting');
    expect(pipRestingMood([], null)).toBe('curious');
  });

  it('retires a focused-session line when its state or the focus changes', () => {
    const permission = { kind: 'permission', label: 'a', sessionId: 'a' } as const;
    expect(pipEventHolds(permission, [session('a', 'waiting', 'permission')], 'a')).toBe(true);
    expect(pipEventHolds(permission, [session('a', 'running')], 'a')).toBe(false);
    expect(pipEventHolds(permission, [session('a', 'waiting', 'permission'), session('b')], 'b')).toBe(false);
    expect(pipEventHolds(permission, [], null)).toBe(false);
    const ready = { kind: 'ready', label: 'a', sessionId: 'a' } as const;
    expect(pipEventHolds(ready, [session('a', 'waiting', 'idle')], 'a')).toBe(true);
    expect(pipEventHolds(ready, [session('a', 'waiting', 'permission')], 'a')).toBe(false);
    expect(pipEventHolds({ kind: 'working', label: 'a', sessionId: 'a' }, [session('a', 'starting')], 'a')).toBe(true);
    expect(pipEventHolds({ kind: 'stopped', label: 'a', sessionId: 'a' }, [session('a', 'dead')], 'a')).toBe(true);
    expect(pipEventHolds({ kind: 'idle', label: 'a', sessionId: 'a' }, [session('a', 'running')], 'a')).toBe(false);
    expect(pipEventHolds({ kind: 'switch', label: 'a', sessionId: 'a' }, [session('a'), session('b')], 'b')).toBe(false);
  });

  it('retires a background line once that session is focused or stops waiting', () => {
    const attention = { kind: 'attention', label: 'b', sessionId: 'b' } as const;
    const waiting = [session('a'), session('b', 'waiting', 'idle'), session('c')];
    expect(pipEventHolds(attention, waiting, 'a')).toBe(true);
    expect(pipEventHolds(attention, waiting, 'c')).toBe(true);
    expect(pipEventHolds(attention, waiting, 'b')).toBe(false);
    expect(pipEventHolds(attention, [session('a'), session('b')], 'a')).toBe(false);
    expect(pipEventHolds(attention, [session('a')], 'a')).toBe(false);
  });

  it('keeps lines that describe no session state', () => {
    for (const kind of ['pet', 'nap', 'submitted', 'dizzy'] as const) {
      expect(pipEventHolds({ kind, label: '' }, [], null)).toBe(true);
    }
    expect(pipEventHolds({ kind: 'pet', label: '', sessionId: 'gone' }, [], null)).toBe(true);
  });

  it('every event the observer emits holds at the moment it is emitted', () => {
    const observer = new PipObserver();
    observer.seed([session('a'), session('b')], 'a');
    const steps: Array<[PipSession[], string | null]> = [
      [[session('a', 'waiting', 'permission'), session('b')], 'a'],
      [[session('a', 'waiting', 'permission'), session('b', 'waiting', 'idle')], 'a'],
      [[session('a', 'waiting', 'permission'), session('b', 'waiting', 'idle')], 'b'],
      [[session('a', 'waiting', 'permission'), session('b', 'idle')], 'b'],
      [[session('a', 'waiting', 'permission'), session('b', 'idle')], 'a'],
      [[session('a', 'dead'), session('b', 'idle')], 'a'],
    ];
    const kinds = steps.map(([sessions, activeId], index) => {
      const event = observer.observe(sessions, activeId, index * 10000);
      expect(event && pipEventHolds(event, sessions, activeId)).toBe(true);
      return event?.kind;
    });
    expect(kinds).toEqual(['permission', 'attention', 'switch', 'idle', 'permission', 'stopped']);
  });
});

describe('Pip presentation preferences and reactions', () => {
  it.each([null, '', 'invalid', 'null', '[]', 'true', '"x"'])('recovers corrupt or missing preferences: %s', raw => {
    expect(readPipSettings(raw)).toEqual(DEFAULT_PIP_SETTINGS);
  });

  it('accepts only known preferences and valid types', () => {
    expect(readPipSettings('{"enabled":true,"collapsed":true,"quiet":true,"motion":false,"personality":"sweet","unknown":123}'))
      .toEqual({ ...DEFAULT_PIP_SETTINGS, enabled: true, collapsed: true, quiet: true, motion: false, personality: 'sweet' });
    expect(readPipSettings('{"enabled":"true","collapsed":0,"quiet":{},"motion":null,"personality":"unknown"}')).toEqual(DEFAULT_PIP_SETTINGS);
  });

  it('uses labels and platform-neutral directory fallbacks', () => {
    expect(pipSessionLabel()).toBe('your sessions');
    expect(pipSessionLabel({ ...session('a'), label: '', workingDir: 'C:\\repo\\tether\\' })).toBe('tether');
    expect(pipSessionLabel({ ...session('a'), label: '', workingDir: '/repo/jobs/' })).toBe('jobs');
  });

  it.each([
    ['starting', undefined, 'busy'], ['running', undefined, 'busy'], ['waiting', 'permission', 'permission'],
    ['waiting', 'idle', 'waiting'], ['idle', undefined, 'sleepy'], ['dead', undefined, 'concerned'], ['stopped', undefined, 'concerned'],
  ] as const)('shows the %s session expression', (state, reason, mood) => expect(pipSessionMood(session('a', state, reason))).toBe(mood));

  it('has a welcoming expression without a session', () => expect(pipSessionMood()).toBe('curious'));

  it.each(['dry', 'sweet'] as const)('varies every %s event and renders labels as plain text', personality => {
    const kinds: PipEventKind[] = ['switch', 'dizzy', 'working', 'permission', 'ready', 'idle', 'stopped', 'attention', 'pet', 'nap'];
    for (const kind of kinds) {
      const first = pipReaction({ kind, label: '<script>example</script>' }, personality);
      const next = pipReaction({ kind, label: '<script>example</script>' }, personality, 1);
      expect(first.line).not.toContain('{session}');
      expect(next.line).not.toBe(first.line);
      expect(first.mood).toBeTruthy();
    }
  });
});
