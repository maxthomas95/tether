import { Notification, type BrowserWindow } from 'electron';
import path from 'node:path';
import { createLogger } from '../logger';
import type { NotificationPrefs, SessionState, WaitingReason } from '../../shared/types';
import { DEFAULT_NOTIFICATION_PREFS } from '../../shared/types';
import { decryptConfigValue, encryptConfigValue } from '../ipc/config-handlers';

const log = createLogger('notifications');

/**
 * Minimal projection of a session for the notification body — we only need
 * what's used in the title/body and the click handler. Decouples the service
 * from the live Session class so tests don't have to construct the whole
 * runtime object graph.
 */
export interface NotifiedSession {
  id: string;
  label: string;
  workingDir: string;
  /** Resolved env name, or undefined for local/no-env sessions. */
  environmentName?: string;
  /** When true, the session opted out of notifications. */
  notificationsMuted?: boolean;
}

/**
 * Subset of BrowserWindow we depend on. The real `BrowserWindow` satisfies
 * this; tests pass a hand-rolled stub so we don't pay for Electron init.
 */
export interface NotificationWindow {
  isFocused(): boolean;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

/** Hook used by the service to escalate notification clicks back to the renderer. */
export type SessionSelectCallback = (sessionId: string) => void;

/**
 * Spec-defined transitions we surface as notifications. Maps 1:1 to the
 * `NotificationPrefs` flag names so the toggle logic stays trivial.
 */
export type NotificationKind = 'waiting' | 'idle' | 'error' | 'bell';

/** Maps each notification kind to the prefs flag that gates it. */
const KIND_TO_PREF: Record<NotificationKind, keyof Omit<NotificationPrefs, 'suppressWhenFocused'>> = {
  waiting: 'onWaiting',
  idle: 'onIdle',
  error: 'onError',
  bell: 'onBell',
};

export interface NotificationServiceOptions {
  /** Returns the live notification preferences. Read on every fire so the
   *  user's most recent settings take effect without a restart. */
  getPrefs: () => NotificationPrefs;
  /** Hook to push the click event over IPC. */
  onSessionSelect: SessionSelectCallback;
  /** The main window — used for focus suppression + click focus. */
  getWindow: () => NotificationWindow | null;
  /** Optional override: Electron's `Notification.isSupported()` check.
   *  Tests pass `() => true` so they don't depend on the OS. */
  isSupported?: () => boolean;
  /** Factory for the Notification object — overridable for tests. */
  createNotification?: (opts: { title: string; body: string; silent?: boolean; icon?: string }) => {
    show: () => void;
    on: (event: 'click', cb: () => void) => void;
  };
  /** Optional path to the app icon. When provided, attached to the Notification. */
  iconPath?: string;
}

/**
 * Compose the notification body line. Format:
 *   "<label> · <env name> — <abbreviated workingDir>"
 * The environment name is omitted for local/no-env sessions; the working
 * dir is shortened to the last 2 path segments so long paths don't bloat
 * the toast on Windows.
 */
export function buildNotificationBody(session: NotifiedSession, message: string): string {
  const parts: string[] = [];
  parts.push(session.label);
  if (session.environmentName) parts.push(session.environmentName);
  const head = parts.join(' · '); // middle dot
  const dir = abbreviateWorkingDir(session.workingDir);
  return `${message}\n${head} — ${dir}`;
}

function abbreviateWorkingDir(p: string): string {
  if (!p) return '';
  const segs = p.split(/[\\/]/).filter(Boolean);
  if (segs.length <= 2) return p;
  return `…/${segs.slice(-2).join('/')}`;
}

/**
 * Per-kind copy. Keep these short — Windows toasts truncate aggressively.
 */
export function titleForKind(kind: NotificationKind): string {
  switch (kind) {
    case 'waiting':   return 'Session waiting';
    case 'idle':      return 'Session idle';
    case 'error':     return 'Session ended unexpectedly';
    case 'bell':      return 'Session alert';
  }
}

export function messageForKind(kind: NotificationKind, reason?: WaitingReason): string {
  if (kind === 'waiting') {
    if (reason === 'permission') return 'Awaiting a permission prompt response.';
    return 'Awaiting your input.';
  }
  if (kind === 'idle')  return 'No activity for a while.';
  if (kind === 'error') return 'Process exited with an error.';
  return 'A terminal bell was rung.';
}

export class NotificationService {
  private readonly opts: NotificationServiceOptions;
  private readonly isSupportedFn: () => boolean;
  private readonly createFn: NonNullable<NotificationServiceOptions['createNotification']>;

  constructor(opts: NotificationServiceOptions) {
    this.opts = opts;
    this.isSupportedFn = opts.isSupported ?? (() => Notification.isSupported());
    this.createFn = opts.createNotification ?? ((o) => {
      const n = new Notification(o);
      return {
        show: () => n.show(),
        on: (event, cb) => n.on(event, cb),
      };
    });
  }

  /**
   * Decide-and-fire entrypoint. Pure-ish: pulls prefs + focus state, runs
   * the gate, and either fires or no-ops. Exposed as a single call site so
   * callers (session-manager) don't need to know the gate logic.
   *
   * Returns the reason for suppression (or `'fired'`) so tests can assert
   * the gate without spying on the Notification factory directly.
   */
  fire(kind: NotificationKind, session: NotifiedSession, reason?: WaitingReason): FireResult {
    if (!this.isSupportedFn()) return 'unsupported';
    const prefs = this.opts.getPrefs();
    if (!prefs[KIND_TO_PREF[kind]]) return 'pref-disabled';
    if (session.notificationsMuted) return 'session-muted';
    if (prefs.suppressWhenFocused && this.isWindowFocused()) return 'window-focused';

    try {
      const title = titleForKind(kind);
      const body = buildNotificationBody(session, messageForKind(kind, reason));
      const notification = this.createFn({
        title,
        body,
        silent: false,
        ...(this.opts.iconPath ? { icon: this.opts.iconPath } : {}),
      });
      notification.on('click', () => this.handleClick(session.id));
      notification.show();
      return 'fired';
    } catch (err) {
      log.warn('Failed to fire notification', {
        kind,
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return 'error';
    }
  }

  private isWindowFocused(): boolean {
    const win = this.opts.getWindow();
    if (!win || win.isDestroyed()) return false;
    return win.isFocused();
  }

  private handleClick(sessionId: string): void {
    const win = this.opts.getWindow();
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    try {
      this.opts.onSessionSelect(sessionId);
    } catch (err) {
      log.warn('Notification click callback threw', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export type FireResult = 'fired' | 'unsupported' | 'pref-disabled' | 'session-muted' | 'window-focused' | 'error';

/**
 * Classify a state transition into a NotificationKind, or null when the
 * transition isn't worth surfacing. Centralized so the session-manager
 * doesn't have to know the mapping.
 *
 * Rules:
 *   - any → 'waiting'           → 'waiting' notification
 *   - any → 'idle'              → 'idle' notification
 *   - any → 'dead' (exit != 0)  → 'error' notification (caller passes
 *     `exitCode` separately via `classifyExit`)
 *   - everything else           → null
 */
export function classifyTransition(
  prev: SessionState,
  next: SessionState,
): NotificationKind | null {
  if (prev === next) return null;
  if (next === 'waiting') return 'waiting';
  if (next === 'idle')    return 'idle';
  return null;
}

/**
 * `markExited` lands as `state === 'dead'` for non-zero exits or `'stopped'`
 * for clean exits. Only the dead path is interesting for notifications —
 * stopped sessions are usually user-initiated.
 */
export function classifyExit(exitCode: number): NotificationKind | null {
  return exitCode === 0 ? null : 'error';
}

/**
 * Lookup helper used by the IPC layer to read prefs out of the JSON config
 * store. Falls back to the defaults whenever a key is missing or has a
 * non-string value. Storing as `'true'`/`'false'` strings keeps the prefs
 * round-trippable through the existing key/value config table without
 * needing a schema migration.
 */
export function readPrefsFromConfig(config: Record<string, string | undefined>): NotificationPrefs {
  return {
    onWaiting:           readBool(config['notifications.onWaiting'],           DEFAULT_NOTIFICATION_PREFS.onWaiting),
    onIdle:              readBool(config['notifications.onIdle'],              DEFAULT_NOTIFICATION_PREFS.onIdle),
    onError:             readBool(config['notifications.onError'],             DEFAULT_NOTIFICATION_PREFS.onError),
    onBell:              readBool(config['notifications.onBell'],              DEFAULT_NOTIFICATION_PREFS.onBell),
    suppressWhenFocused: readBool(config['notifications.suppressWhenFocused'], DEFAULT_NOTIFICATION_PREFS.suppressWhenFocused),
    webhook: {
      url:       (config['notifications.webhook.url'] ?? DEFAULT_NOTIFICATION_PREFS.webhook.url).trim(),
      token:     decryptConfigValue('notifications.webhook.token', config['notifications.webhook.token'] ?? '').trim(),
      onWaiting: readBool(config['notifications.webhook.onWaiting'], DEFAULT_NOTIFICATION_PREFS.webhook.onWaiting),
      onIdle:    readBool(config['notifications.webhook.onIdle'],    DEFAULT_NOTIFICATION_PREFS.webhook.onIdle),
      onDead:    readBool(config['notifications.webhook.onDead'],    DEFAULT_NOTIFICATION_PREFS.webhook.onDead),
      onBell:    readBool(config['notifications.webhook.onBell'],    DEFAULT_NOTIFICATION_PREFS.webhook.onBell),
    },
  };
}

export function writePrefsToConfig(
  config: Record<string, string>,
  prefs: NotificationPrefs,
): void {
  config['notifications.onWaiting']           = prefs.onWaiting           ? 'true' : 'false';
  config['notifications.onIdle']              = prefs.onIdle              ? 'true' : 'false';
  config['notifications.onError']             = prefs.onError             ? 'true' : 'false';
  config['notifications.onBell']              = prefs.onBell              ? 'true' : 'false';
  config['notifications.suppressWhenFocused'] = prefs.suppressWhenFocused ? 'true' : 'false';
  config['notifications.webhook.url']         = prefs.webhook.url.trim();
  config['notifications.webhook.token']       = encryptConfigValue('notifications.webhook.token', prefs.webhook.token?.trim() ?? '');
  config['notifications.webhook.onWaiting']   = prefs.webhook.onWaiting   ? 'true' : 'false';
  config['notifications.webhook.onIdle']      = prefs.webhook.onIdle      ? 'true' : 'false';
  config['notifications.webhook.onDead']      = prefs.webhook.onDead      ? 'true' : 'false';
  config['notifications.webhook.onBell']      = prefs.webhook.onBell      ? 'true' : 'false';
}

function readBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === 'true')  return true;
  if (raw === 'false') return false;
  return fallback;
}

/**
 * Convenience factory used by the main process — wires the real BrowserWindow
 * + a `'click'` listener through to the renderer-side IPC channel.
 */
export function createNotificationService(opts: {
  getWindow: () => BrowserWindow | null;
  getPrefs: () => NotificationPrefs;
  onSessionSelect: SessionSelectCallback;
}): NotificationService {
  // Bundle the app icon if it's discoverable at the usual path. Best-effort
  // — Notification accepts missing icons silently.
  const iconCandidate = path.join(__dirname, '../../assets/icon.ico');
  return new NotificationService({
    getPrefs: opts.getPrefs,
    onSessionSelect: opts.onSessionSelect,
    getWindow: opts.getWindow,
    iconPath: iconCandidate,
  });
}
