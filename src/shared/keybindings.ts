export type KeybindingAction =
  | 'session.new'
  | 'session.stop'
  | 'search.open'
  | 'sidebar.toggle'
  | 'settings.open'
  | 'shortcuts.show'
  | 'session.next'
  | 'session.prev'
  | 'session.nextWaiting'
  | 'session.switch.1'
  | 'session.switch.2'
  | 'session.switch.3'
  | 'session.switch.4'
  | 'session.switch.5'
  | 'session.switch.6'
  | 'session.switch.7'
  | 'session.switch.8'
  | 'session.switch.9'
  | 'pane.focus.left'
  | 'pane.focus.right'
  | 'pane.focus.up'
  | 'pane.focus.down'
  | 'pane.swap.left'
  | 'pane.swap.right'
  | 'pane.swap.up'
  | 'pane.swap.down'
  | 'zoom.in'
  | 'zoom.out'
  | 'zoom.reset';

export type Chord = string;

export type KeybindingOverrides = Partial<Record<KeybindingAction, Chord | null>>;

export const ALL_ACTIONS: KeybindingAction[] = [
  'session.new',
  'session.stop',
  'search.open',
  'sidebar.toggle',
  'settings.open',
  'shortcuts.show',
  'session.next',
  'session.prev',
  'session.nextWaiting',
  'session.switch.1',
  'session.switch.2',
  'session.switch.3',
  'session.switch.4',
  'session.switch.5',
  'session.switch.6',
  'session.switch.7',
  'session.switch.8',
  'session.switch.9',
  'pane.focus.left',
  'pane.focus.right',
  'pane.focus.up',
  'pane.focus.down',
  'pane.swap.left',
  'pane.swap.right',
  'pane.swap.up',
  'pane.swap.down',
  'zoom.in',
  'zoom.out',
  'zoom.reset',
];

export const DEFAULT_KEYBINDINGS: Record<KeybindingAction, Chord> = {
  'session.new': 'ctrl+n',
  'session.stop': 'ctrl+w',
  'search.open': 'ctrl+p',
  'sidebar.toggle': 'ctrl+b',
  'settings.open': 'ctrl+,',
  'shortcuts.show': 'ctrl+/',
  'session.next': 'ctrl+arrowdown',
  'session.prev': 'ctrl+arrowup',
  'session.nextWaiting': 'ctrl+shift+a',
  'session.switch.1': 'ctrl+1',
  'session.switch.2': 'ctrl+2',
  'session.switch.3': 'ctrl+3',
  'session.switch.4': 'ctrl+4',
  'session.switch.5': 'ctrl+5',
  'session.switch.6': 'ctrl+6',
  'session.switch.7': 'ctrl+7',
  'session.switch.8': 'ctrl+8',
  'session.switch.9': 'ctrl+9',
  'pane.focus.left': 'alt+arrowleft',
  'pane.focus.right': 'alt+arrowright',
  'pane.focus.up': 'alt+arrowup',
  'pane.focus.down': 'alt+arrowdown',
  'pane.swap.left': 'alt+shift+arrowleft',
  'pane.swap.right': 'alt+shift+arrowright',
  'pane.swap.up': 'alt+shift+arrowup',
  'pane.swap.down': 'alt+shift+arrowdown',
  'zoom.in': 'ctrl+=',
  'zoom.out': 'ctrl+-',
  'zoom.reset': 'ctrl+0',
};

export const ACTION_LABELS: Record<KeybindingAction, string> = {
  'session.new': 'New session',
  'session.stop': 'Stop current session',
  'search.open': 'Find session',
  'sidebar.toggle': 'Toggle sidebar',
  'settings.open': 'Open settings',
  'shortcuts.show': 'Show keyboard shortcuts',
  'session.next': 'Focus next pane',
  'session.prev': 'Focus previous pane',
  'session.nextWaiting': 'Jump to Next Waiting Session',
  'session.switch.1': 'Switch to session 1',
  'session.switch.2': 'Switch to session 2',
  'session.switch.3': 'Switch to session 3',
  'session.switch.4': 'Switch to session 4',
  'session.switch.5': 'Switch to session 5',
  'session.switch.6': 'Switch to session 6',
  'session.switch.7': 'Switch to session 7',
  'session.switch.8': 'Switch to session 8',
  'session.switch.9': 'Switch to session 9',
  'pane.focus.left': 'Focus pane to the left',
  'pane.focus.right': 'Focus pane to the right',
  'pane.focus.up': 'Focus pane above',
  'pane.focus.down': 'Focus pane below',
  'pane.swap.left': 'Swap pane with neighbor on left',
  'pane.swap.right': 'Swap pane with neighbor on right',
  'pane.swap.up': 'Swap pane with neighbor above',
  'pane.swap.down': 'Swap pane with neighbor below',
  'zoom.in': 'Zoom window in',
  'zoom.out': 'Zoom window out',
  'zoom.reset': 'Reset window zoom',
};

export type ActionGroup = 'Session' | 'Switch' | 'Panes' | 'View' | 'Window' | 'Help';

export const ACTION_GROUPS: Record<KeybindingAction, ActionGroup> = {
  'session.new': 'Session',
  'session.stop': 'Session',
  'search.open': 'Session',
  'session.next': 'Panes',
  'session.prev': 'Panes',
  'session.nextWaiting': 'Session',
  'session.switch.1': 'Switch',
  'session.switch.2': 'Switch',
  'session.switch.3': 'Switch',
  'session.switch.4': 'Switch',
  'session.switch.5': 'Switch',
  'session.switch.6': 'Switch',
  'session.switch.7': 'Switch',
  'session.switch.8': 'Switch',
  'session.switch.9': 'Switch',
  'pane.focus.left': 'Panes',
  'pane.focus.right': 'Panes',
  'pane.focus.up': 'Panes',
  'pane.focus.down': 'Panes',
  'pane.swap.left': 'Panes',
  'pane.swap.right': 'Panes',
  'pane.swap.up': 'Panes',
  'pane.swap.down': 'Panes',
  'sidebar.toggle': 'View',
  'settings.open': 'View',
  'zoom.in': 'Window',
  'zoom.out': 'Window',
  'zoom.reset': 'Window',
  'shortcuts.show': 'Help',
};

export const ACTION_GROUP_ORDER: ActionGroup[] = ['Session', 'Switch', 'Panes', 'View', 'Window', 'Help'];

export const RESERVED_CHORDS: Record<Chord, string> = {
  'ctrl+c': 'Terminal interrupt (SIGINT)',
  'ctrl+d': 'Terminal EOF / exit',
  'ctrl+z': 'Terminal suspend',
  'ctrl+l': 'Terminal clear screen',
  'ctrl+r': 'Terminal reverse history search',
  'ctrl+a': 'Readline: cursor to line start',
  'ctrl+e': 'Readline: cursor to line end',
  'ctrl+k': 'Readline: kill to end of line',
  'ctrl+u': 'Readline: kill to line start',
  'ctrl+t': 'Terminal new tab in many shells',
  'ctrl+shift+r': 'Browser/Electron: hard reload',
  'ctrl+shift+i': 'Electron DevTools',
  'alt+f4': 'OS: close window',
  'f11': 'OS: toggle fullscreen',
};

const MODIFIER_KEYS = new Set(['control', 'ctrl', 'shift', 'alt', 'meta', 'super', 'cmd', 'command', 'os', 'win', 'hyper']);

function isModifierKey(key: string): boolean {
  return MODIFIER_KEYS.has(key.toLowerCase());
}

function canonicalizeKey(raw: string): string {
  const k = raw.toLowerCase();
  if (k === ' ' || k === 'spacebar') return 'space';
  if (k === 'esc') return 'escape';
  if (k === 'del') return 'delete';
  if (k === 'ins') return 'insert';
  if (k === 'pgup') return 'pageup';
  if (k === 'pgdn' || k === 'pgdown') return 'pagedown';
  if (k === 'left' || k === '←') return 'arrowleft';
  if (k === 'right' || k === '→') return 'arrowright';
  if (k === 'up' || k === '↑') return 'arrowup';
  if (k === 'down' || k === '↓') return 'arrowdown';
  if (k === 'plus') return '=';
  return k;
}

function buildChord(parts: { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean; key: string }): Chord {
  const segments: string[] = [];
  if (parts.ctrl) segments.push('ctrl');
  if (parts.alt) segments.push('alt');
  if (parts.shift) segments.push('shift');
  if (parts.meta) segments.push('meta');
  segments.push(parts.key);
  return segments.join('+');
}

export function parseKeyEvent(e: KeyboardEvent): Chord | null {
  const rawKey = e.key;
  if (!rawKey || isModifierKey(rawKey)) return null;

  let key = canonicalizeKey(rawKey);

  const shift = e.shiftKey;
  let useShift = shift;
  if (shift && key.length === 1) {
    const lower = key.toLowerCase();
    if (lower >= 'a' && lower <= 'z') {
      key = lower;
    } else {
      useShift = false;
    }
  }

  return buildChord({
    ctrl: e.ctrlKey,
    alt: e.altKey,
    shift: useShift,
    meta: e.metaKey,
    key,
  });
}

export function normalizeChord(input: string): Chord {
  if (!input) return '';
  const trimmed = input.trim();
  if (!trimmed) return '';

  let parts: string[];
  if (trimmed.length === 1) {
    parts = [trimmed];
  } else {
    parts = trimmed.split('+').map(p => p.trim()).filter(p => p.length > 0);
    if (parts.length === 0) parts = [trimmed];
  }

  let ctrl = false;
  let alt = false;
  let shift = false;
  let meta = false;
  let keyPart = '';

  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'ctrl' || lower === 'control') {
      ctrl = true;
    } else if (lower === 'alt' || lower === 'option' || lower === 'opt') {
      alt = true;
    } else if (lower === 'shift') {
      shift = true;
    } else if (lower === 'meta' || lower === 'cmd' || lower === 'command' || lower === 'super' || lower === 'win') {
      meta = true;
    } else {
      keyPart = canonicalizeKey(part);
    }
  }

  if (!keyPart) return '';
  return buildChord({ ctrl, alt, shift, meta, key: keyPart });
}

function prettyKey(key: string): string {
  switch (key) {
    case 'arrowup': return '↑';
    case 'arrowdown': return '↓';
    case 'arrowleft': return '←';
    case 'arrowright': return '→';
    case 'escape': return 'Esc';
    case 'enter': return 'Enter';
    case 'return': return 'Enter';
    case 'tab': return 'Tab';
    case 'space': return 'Space';
    case 'backspace': return 'Backspace';
    case 'delete': return 'Del';
    case 'insert': return 'Ins';
    case 'home': return 'Home';
    case 'end': return 'End';
    case 'pageup': return 'PgUp';
    case 'pagedown': return 'PgDn';
    default:
      if (key.length === 1) return key.toUpperCase();
      if (/^f\d{1,2}$/.test(key)) return key.toUpperCase();
      return key.charAt(0).toUpperCase() + key.slice(1);
  }
}

export function formatChord(chord: Chord | null | undefined): string {
  if (!chord) return '';
  const parts = chord.split('+');
  const key = parts.pop();
  if (!key) return '';
  const modifiers: string[] = [];
  for (const p of parts) {
    if (p === 'ctrl') modifiers.push('Ctrl');
    else if (p === 'alt') modifiers.push('Alt');
    else if (p === 'shift') modifiers.push('Shift');
    else if (p === 'meta') modifiers.push('Meta');
  }
  return [...modifiers, prettyKey(key)].join('+');
}

export function chordEquals(a: Chord | null | undefined, b: Chord | null | undefined): boolean {
  if (a == null || b == null) return a == null && b == null;
  return a.toLowerCase() === b.toLowerCase();
}

export function getReservedReason(chord: Chord | null | undefined): string | null {
  if (!chord) return null;
  return RESERVED_CHORDS[chord.toLowerCase()] ?? null;
}

export interface BindingConflict {
  chord: Chord;
  actions: KeybindingAction[];
}

export function resolveBindings(
  overrides: KeybindingOverrides | null | undefined,
): Record<KeybindingAction, Chord | null> {
  const result = {} as Record<KeybindingAction, Chord | null>;
  for (const action of ALL_ACTIONS) {
    if (overrides && Object.hasOwn(overrides, action)) {
      result[action] = resolveOverride(overrides[action], action);
    } else {
      result[action] = DEFAULT_KEYBINDINGS[action];
    }
  }
  return result;
}

function resolveOverride(value: Chord | null | undefined, action: KeybindingAction): Chord | null {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  return DEFAULT_KEYBINDINGS[action];
}

export function findConflicts(
  bindings: Record<KeybindingAction, Chord | null>,
): BindingConflict[] {
  const byChord = new Map<Chord, KeybindingAction[]>();
  for (const action of ALL_ACTIONS) {
    const chord = bindings[action];
    if (!chord) continue;
    const key = chord.toLowerCase();
    const list = byChord.get(key);
    if (list) list.push(action);
    else byChord.set(key, [action]);
  }
  const conflicts: BindingConflict[] = [];
  for (const [chord, actions] of byChord) {
    if (actions.length > 1) conflicts.push({ chord, actions });
  }
  return conflicts;
}
