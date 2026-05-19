import { describe, expect, it, vi } from 'vitest';
import {
  NotificationService,
  buildNotificationBody,
  classifyExit,
  classifyTransition,
  readPrefsFromConfig,
  writePrefsToConfig,
  type NotificationWindow,
  type NotifiedSession,
} from './notification-service';
import { DEFAULT_NOTIFICATION_PREFS, type NotificationPrefs } from '../../shared/types';

// Electron's Notification module is unavailable in the Vitest worker — every
// test passes `createNotification` and `isSupported` overrides so the service
// never touches the real module.
vi.mock('electron', () => ({
  Notification: { isSupported: () => true },
}));

function makeWindow(focused: boolean, destroyed = false): NotificationWindow {
  return {
    isFocused: () => focused,
    isDestroyed: () => destroyed,
    isMinimized: () => false,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  };
}

function makeSession(overrides: Partial<NotifiedSession> = {}): NotifiedSession {
  return {
    id: 'sess-1',
    label: 'tether-feat',
    workingDir: 'C:\\repo\\tether',
    environmentName: undefined,
    notificationsMuted: false,
    ...overrides,
  };
}

interface FakeNotification {
  shown: boolean;
  clickCb: (() => void) | null;
}

function makeServiceWithSpy(opts: {
  prefs?: Partial<NotificationPrefs>;
  window?: NotificationWindow;
  isSupported?: boolean;
  onSessionSelect?: (id: string) => void;
}) {
  const created: FakeNotification[] = [];
  const fakeCreate = vi.fn(() => {
    const fake: FakeNotification = { shown: false, clickCb: null };
    created.push(fake);
    return {
      show: () => { fake.shown = true; },
      on: (_event: 'click', cb: () => void) => { fake.clickCb = cb; },
    };
  });
  const onSessionSelect = vi.fn(opts.onSessionSelect ?? (() => {}));
  const service = new NotificationService({
    getPrefs: () => ({ ...DEFAULT_NOTIFICATION_PREFS, ...(opts.prefs ?? {}) }),
    onSessionSelect,
    getWindow: () => opts.window ?? makeWindow(false),
    isSupported: () => opts.isSupported ?? true,
    createNotification: fakeCreate,
  });
  return { service, fakeCreate, created, onSessionSelect };
}

describe('NotificationService.fire', () => {
  it('fires when the OS supports it, the pref is on, and the window is unfocused', () => {
    const { service, fakeCreate, created } = makeServiceWithSpy({ window: makeWindow(false) });
    expect(service.fire('waiting', makeSession())).toBe('fired');
    expect(fakeCreate).toHaveBeenCalledTimes(1);
    expect(created[0].shown).toBe(true);
  });

  it('returns "unsupported" and does not call the factory when the OS lacks Notifications', () => {
    const { service, fakeCreate } = makeServiceWithSpy({ isSupported: false });
    expect(service.fire('waiting', makeSession())).toBe('unsupported');
    expect(fakeCreate).not.toHaveBeenCalled();
  });

  it('returns "pref-disabled" and does not fire when the matching pref is off', () => {
    const { service, fakeCreate } = makeServiceWithSpy({ prefs: { onWaiting: false } });
    expect(service.fire('waiting', makeSession())).toBe('pref-disabled');
    expect(fakeCreate).not.toHaveBeenCalled();
  });

  it('returns "session-muted" when the session opted out via per-session toggle', () => {
    // Explicit `onIdle: true` — defaults have idle off (opt-in), but this
    // test is about the per-session mute taking priority over an enabled pref.
    const { service, fakeCreate } = makeServiceWithSpy({ prefs: { onIdle: true } });
    expect(service.fire('idle', makeSession({ notificationsMuted: true }))).toBe('session-muted');
    expect(fakeCreate).not.toHaveBeenCalled();
  });

  it('suppresses when window is focused AND suppressWhenFocused is on (default)', () => {
    const { service, fakeCreate } = makeServiceWithSpy({ window: makeWindow(true) });
    expect(service.fire('waiting', makeSession())).toBe('window-focused');
    expect(fakeCreate).not.toHaveBeenCalled();
  });

  it('still fires while focused when suppressWhenFocused is off', () => {
    const { service, fakeCreate } = makeServiceWithSpy({
      window: makeWindow(true),
      prefs: { suppressWhenFocused: false },
    });
    expect(service.fire('waiting', makeSession())).toBe('fired');
    expect(fakeCreate).toHaveBeenCalledTimes(1);
  });

  it('treats a destroyed window as not focused (no suppression)', () => {
    // Explicit `onError: true` — defaults have error off (opt-in).
    const { service } = makeServiceWithSpy({ window: makeWindow(true, true), prefs: { onError: true } });
    expect(service.fire('error', makeSession())).toBe('fired');
  });

  it('routes click → window.show/focus + onSessionSelect callback', () => {
    const win = makeWindow(false);
    const { service, created, onSessionSelect } = makeServiceWithSpy({ window: win, prefs: { onError: true } });
    service.fire('error', makeSession({ id: 'click-target' }));
    expect(created[0].clickCb).not.toBeNull();
    created[0].clickCb!();
    expect(win.show).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
    expect(onSessionSelect).toHaveBeenCalledWith('click-target');
  });

  it('checks all four kinds against their distinct prefs flags', () => {
    const prefs: NotificationPrefs = { onWaiting: false, onIdle: true, onError: false, onBell: true, suppressWhenFocused: false };
    const { service, fakeCreate } = makeServiceWithSpy({ prefs });
    expect(service.fire('waiting', makeSession())).toBe('pref-disabled');
    expect(service.fire('idle', makeSession())).toBe('fired');
    expect(service.fire('error', makeSession())).toBe('pref-disabled');
    expect(service.fire('bell', makeSession())).toBe('fired');
    expect(fakeCreate).toHaveBeenCalledTimes(2);
  });
});

describe('classifyTransition', () => {
  it('returns null when prev === next (no transition)', () => {
    expect(classifyTransition('running', 'running')).toBeNull();
  });

  it('maps any → waiting → "waiting"', () => {
    expect(classifyTransition('running', 'waiting')).toBe('waiting');
    expect(classifyTransition('starting', 'waiting')).toBe('waiting');
  });

  it('maps any → idle → "idle"', () => {
    expect(classifyTransition('waiting', 'idle')).toBe('idle');
    expect(classifyTransition('running', 'idle')).toBe('idle');
  });

  it('ignores other transitions (no notification by state alone)', () => {
    expect(classifyTransition('starting', 'running')).toBeNull();
    expect(classifyTransition('waiting', 'running')).toBeNull();
    expect(classifyTransition('idle', 'running')).toBeNull();
    expect(classifyTransition('running', 'stopped')).toBeNull();
  });
});

describe('classifyExit', () => {
  it('returns null on a clean exit (code 0)', () => {
    expect(classifyExit(0)).toBeNull();
  });

  it('returns "error" on any non-zero exit', () => {
    expect(classifyExit(1)).toBe('error');
    expect(classifyExit(127)).toBe('error');
    expect(classifyExit(-1)).toBe('error');
  });
});

describe('buildNotificationBody', () => {
  it('omits environment when not provided', () => {
    const body = buildNotificationBody(makeSession({ workingDir: '/short' }), 'Awaiting input');
    expect(body).toContain('Awaiting input');
    expect(body).toContain('tether-feat');
    expect(body).not.toContain('·');
  });

  it('includes environment when provided', () => {
    const body = buildNotificationBody(
      makeSession({ environmentName: 'prod-vm' }),
      'Awaiting input',
    );
    expect(body).toContain('tether-feat · prod-vm');
  });

  it('abbreviates deep working dirs to last two segments', () => {
    const body = buildNotificationBody(
      makeSession({ workingDir: 'C:\\Users\\dev\\code\\projects\\app' }),
      'msg',
    );
    expect(body).toContain('projects/app');
    expect(body).toContain('…/');
  });

  it('leaves short paths untouched', () => {
    const body = buildNotificationBody(makeSession({ workingDir: '/a/b' }), 'msg');
    expect(body).toContain('/a/b');
    expect(body).not.toContain('…');
  });
});

describe('prefs persistence helpers', () => {
  it('readPrefsFromConfig falls back to defaults for missing keys', () => {
    expect(readPrefsFromConfig({})).toEqual(DEFAULT_NOTIFICATION_PREFS);
  });

  it('readPrefsFromConfig honors "true"/"false" strings', () => {
    const prefs = readPrefsFromConfig({
      'notifications.onWaiting': 'false',
      'notifications.onIdle': 'true',
      'notifications.onError': 'false',
      'notifications.onBell': 'true',
      'notifications.suppressWhenFocused': 'false',
    });
    expect(prefs).toEqual({
      onWaiting: false, onIdle: true, onError: false, onBell: true, suppressWhenFocused: false,
    });
  });

  it('readPrefsFromConfig ignores unrecognized values and falls back', () => {
    const prefs = readPrefsFromConfig({
      'notifications.onWaiting': 'yes',  // not "true"
      'notifications.onBell': '',        // not "true"
    });
    expect(prefs.onWaiting).toBe(DEFAULT_NOTIFICATION_PREFS.onWaiting);
    expect(prefs.onBell).toBe(DEFAULT_NOTIFICATION_PREFS.onBell);
  });

  it('writePrefsToConfig round-trips through readPrefsFromConfig', () => {
    const original: NotificationPrefs = {
      onWaiting: false, onIdle: true, onError: false, onBell: true, suppressWhenFocused: false,
    };
    const cfg: Record<string, string> = {};
    writePrefsToConfig(cfg, original);
    expect(readPrefsFromConfig(cfg)).toEqual(original);
  });

  it('writePrefsToConfig does not pollute unrelated config keys', () => {
    const cfg: Record<string, string> = { theme: 'mocha', allowHelm: 'true' };
    writePrefsToConfig(cfg, DEFAULT_NOTIFICATION_PREFS);
    expect(cfg.theme).toBe('mocha');
    expect(cfg.allowHelm).toBe('true');
  });
});
