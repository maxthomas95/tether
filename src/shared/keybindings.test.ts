import { describe, it, expect } from 'vitest';
import {
  parseKeyEvent,
  normalizeChord,
  formatChord,
  chordEquals,
  getReservedReason,
  resolveBindings,
  findConflicts,
  DEFAULT_KEYBINDINGS,
  ALL_ACTIONS,
  RESERVED_CHORDS,
  type KeybindingAction,
  type Chord,
} from './keybindings';

function mkEvent(init: {
  key: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
}): KeyboardEvent {
  return {
    key: init.key,
    ctrlKey: !!init.ctrl,
    altKey: !!init.alt,
    shiftKey: !!init.shift,
    metaKey: !!init.meta,
  } as unknown as KeyboardEvent;
}

describe('parseKeyEvent', () => {
  it('returns null for modifier-only presses', () => {
    expect(parseKeyEvent(mkEvent({ key: 'Control', ctrl: true }))).toBeNull();
    expect(parseKeyEvent(mkEvent({ key: 'Shift', shift: true }))).toBeNull();
    expect(parseKeyEvent(mkEvent({ key: 'Alt', alt: true }))).toBeNull();
    expect(parseKeyEvent(mkEvent({ key: 'Meta', meta: true }))).toBeNull();
  });

  it('lowercases letter keys and orders modifiers ctrl+alt+shift+meta', () => {
    expect(parseKeyEvent(mkEvent({ key: 'N', ctrl: true, shift: true }))).toBe('ctrl+shift+n');
    expect(parseKeyEvent(mkEvent({ key: 'n', ctrl: true }))).toBe('ctrl+n');
    expect(parseKeyEvent(mkEvent({ key: 'X', ctrl: true, alt: true, shift: true, meta: true }))).toBe('ctrl+alt+shift+meta+x');
  });

  it('normalizes arrow keys to lowercase canonical form', () => {
    expect(parseKeyEvent(mkEvent({ key: 'ArrowDown', ctrl: true }))).toBe('ctrl+arrowdown');
    expect(parseKeyEvent(mkEvent({ key: 'ArrowUp', ctrl: true }))).toBe('ctrl+arrowup');
  });

  it('drops shift for shifted-symbol keys to avoid ctrl+shift+= when user wants ctrl+=', () => {
    expect(parseKeyEvent(mkEvent({ key: '=', ctrl: true }))).toBe('ctrl+=');
    expect(parseKeyEvent(mkEvent({ key: '+', ctrl: true, shift: true }))).toBe('ctrl++');
  });

  it('handles comma and slash', () => {
    expect(parseKeyEvent(mkEvent({ key: ',', ctrl: true }))).toBe('ctrl+,');
    expect(parseKeyEvent(mkEvent({ key: '/', ctrl: true }))).toBe('ctrl+/');
  });

  it('handles digits', () => {
    expect(parseKeyEvent(mkEvent({ key: '1', ctrl: true }))).toBe('ctrl+1');
    expect(parseKeyEvent(mkEvent({ key: '9', ctrl: true }))).toBe('ctrl+9');
    expect(parseKeyEvent(mkEvent({ key: '0', ctrl: true }))).toBe('ctrl+0');
  });
});

describe('normalizeChord', () => {
  it('lowercases and orders modifiers consistently regardless of input order', () => {
    expect(normalizeChord('Ctrl+Shift+N')).toBe('ctrl+shift+n');
    expect(normalizeChord('shift + CTRL + n')).toBe('ctrl+shift+n');
    expect(normalizeChord('Meta+Alt+Ctrl+Shift+x')).toBe('ctrl+alt+shift+meta+x');
  });

  it('accepts alternative modifier names', () => {
    expect(normalizeChord('Control+N')).toBe('ctrl+n');
    expect(normalizeChord('Option+F')).toBe('alt+f');
    expect(normalizeChord('Cmd+S')).toBe('meta+s');
    expect(normalizeChord('Command+S')).toBe('meta+s');
    expect(normalizeChord('Win+D')).toBe('meta+d');
  });

  it('canonicalizes arrow aliases', () => {
    expect(normalizeChord('Ctrl+Down')).toBe('ctrl+arrowdown');
    expect(normalizeChord('Ctrl+Up')).toBe('ctrl+arrowup');
    expect(normalizeChord('Ctrl+ArrowLeft')).toBe('ctrl+arrowleft');
  });

  it('returns empty string when there is no key portion', () => {
    expect(normalizeChord('')).toBe('');
    expect(normalizeChord('Ctrl+Shift')).toBe('');
  });

  it('preserves single-character keys like + and ,', () => {
    expect(normalizeChord('+')).toBe('+');
    expect(normalizeChord(',')).toBe(',');
  });
});

describe('formatChord', () => {
  it('produces display strings with arrow glyphs and capitalized modifiers', () => {
    expect(formatChord('ctrl+n')).toBe('Ctrl+N');
    expect(formatChord('ctrl+shift+n')).toBe('Ctrl+Shift+N');
    expect(formatChord('ctrl+arrowdown')).toBe('Ctrl+↓');
    expect(formatChord('ctrl+arrowup')).toBe('Ctrl+↑');
    expect(formatChord('ctrl+=')).toBe('Ctrl+=');
    expect(formatChord('ctrl+,')).toBe('Ctrl+,');
    expect(formatChord('ctrl+/')).toBe('Ctrl+/');
    expect(formatChord('alt+f4')).toBe('Alt+F4');
    expect(formatChord('ctrl+alt+shift+meta+x')).toBe('Ctrl+Alt+Shift+Meta+X');
  });

  it('returns empty for null/undefined/empty', () => {
    expect(formatChord(null)).toBe('');
    expect(formatChord(undefined)).toBe('');
    expect(formatChord('')).toBe('');
  });
});

describe('round-trip parse → format → normalize', () => {
  const cases: Array<{ event: Parameters<typeof mkEvent>[0]; expected: Chord }> = [
    { event: { key: 'N', ctrl: true }, expected: 'ctrl+n' },
    { event: { key: 'W', ctrl: true }, expected: 'ctrl+w' },
    { event: { key: ',', ctrl: true }, expected: 'ctrl+,' },
    { event: { key: '/', ctrl: true }, expected: 'ctrl+/' },
    { event: { key: 'ArrowDown', ctrl: true }, expected: 'ctrl+arrowdown' },
    { event: { key: '1', ctrl: true }, expected: 'ctrl+1' },
    { event: { key: '=', ctrl: true }, expected: 'ctrl+=' },
  ];

  for (const { event, expected } of cases) {
    it(`${expected} round-trips`, () => {
      const parsed = parseKeyEvent(mkEvent(event));
      expect(parsed).toBe(expected);
      const display = formatChord(parsed);
      expect(normalizeChord(display)).toBe(expected);
    });
  }
});

describe('chordEquals', () => {
  it('is case-insensitive', () => {
    expect(chordEquals('Ctrl+N', 'ctrl+n')).toBe(true);
    expect(chordEquals('ctrl+n', 'ctrl+m')).toBe(false);
  });

  it('treats null and undefined as equal but distinct from a real chord', () => {
    expect(chordEquals(null, null)).toBe(true);
    expect(chordEquals(undefined, undefined)).toBe(true);
    expect(chordEquals(null, undefined)).toBe(true);
    expect(chordEquals(null, 'ctrl+n')).toBe(false);
  });
});

describe('reserved chord lookup', () => {
  it('looks up by normalized chord', () => {
    expect(getReservedReason('ctrl+c')).toBe('Terminal interrupt (SIGINT)');
    expect(getReservedReason('Ctrl+C')).toBe('Terminal interrupt (SIGINT)');
    expect(getReservedReason('ctrl+shift+i')).toMatch(/DevTools/);
    expect(getReservedReason('alt+f4')).toMatch(/close window/);
  });

  it('returns null for unreserved chords', () => {
    expect(getReservedReason('ctrl+n')).toBeNull();
    expect(getReservedReason(null)).toBeNull();
    expect(getReservedReason('')).toBeNull();
  });

  it('includes the documented baseline reservations', () => {
    const required = ['ctrl+c', 'ctrl+d', 'ctrl+z', 'ctrl+l', 'ctrl+r', 'ctrl+a', 'ctrl+e', 'ctrl+k', 'ctrl+u', 'alt+f4', 'f11', 'ctrl+shift+i', 'ctrl+t'];
    for (const c of required) {
      expect(RESERVED_CHORDS[c]).toBeDefined();
    }
  });
});

describe('resolveBindings', () => {
  it('returns defaults when overrides are empty/nullish', () => {
    const resolved = resolveBindings(null);
    for (const a of ALL_ACTIONS) {
      expect(resolved[a]).toBe(DEFAULT_KEYBINDINGS[a]);
    }
  });

  it('applies string overrides and preserves null (unbound)', () => {
    const resolved = resolveBindings({
      'session.new': 'ctrl+shift+n',
      'session.stop': null,
    });
    expect(resolved['session.new']).toBe('ctrl+shift+n');
    expect(resolved['session.stop']).toBeNull();
    expect(resolved['sidebar.toggle']).toBe(DEFAULT_KEYBINDINGS['sidebar.toggle']);
  });
});

describe('findConflicts', () => {
  it('reports actions sharing a chord', () => {
    const bindings = resolveBindings({
      'session.new': 'ctrl+n',
      'session.stop': 'ctrl+n',
    });
    const conflicts = findConflicts(bindings);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].chord).toBe('ctrl+n');
    expect(conflicts[0].actions.sort()).toEqual<KeybindingAction[]>(['session.new', 'session.stop'].sort() as KeybindingAction[]);
  });

  it('ignores null (unbound) entries', () => {
    const bindings = resolveBindings({
      'session.new': null,
      'session.stop': null,
    });
    expect(findConflicts(bindings)).toEqual([]);
  });

  it('returns empty array when defaults are used (no defaults clash)', () => {
    expect(findConflicts(resolveBindings(null))).toEqual([]);
  });
});

describe('default bindings sanity', () => {
  it('has a default for every action', () => {
    for (const a of ALL_ACTIONS) {
      expect(DEFAULT_KEYBINDINGS[a]).toBeTruthy();
    }
  });

  it('all defaults are in normalized form', () => {
    for (const a of ALL_ACTIONS) {
      const chord = DEFAULT_KEYBINDINGS[a];
      expect(normalizeChord(chord)).toBe(chord);
    }
  });
});
