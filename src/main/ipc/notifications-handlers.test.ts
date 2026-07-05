import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHarness, makeElectronMockBase, type IpcRegistry } from './ipc-test-harness.test-helper';

const registry = vi.hoisted<IpcRegistry>(() => ({ handlers: new Map(), listeners: new Map() }));
vi.mock('electron', () => ({
  ...makeElectronMockBase(registry),
  Notification: { isSupported: () => true },
}));

const dbState = vi.hoisted(() => ({
  config: {} as Record<string, string>,
  saveCount: 0,
}));

vi.mock('../db/database', () => ({
  getDb: () => dbState,
  saveDb: () => { dbState.saveCount += 1; },
}));

const mutedCalls = vi.hoisted(() => ({ args: [] as Array<{ id: string; muted: boolean }> }));
vi.mock('../session/session-manager', () => ({
  sessionManager: {
    setNotificationsMuted: (id: string, muted: boolean) => {
      mutedCalls.args.push({ id, muted });
    },
  },
}));

import { IPC } from '../../shared/constants';
import { DEFAULT_NOTIFICATION_PREFS, type NotificationPrefs } from '../../shared/types';
import { registerNotificationsHandlers } from './notifications-handlers';

const harness = createHarness(registry);

function resetDb() {
  dbState.config = {};
  dbState.saveCount = 0;
  mutedCalls.args.length = 0;
}

describe('notifications-handlers', () => {
  beforeEach(() => {
    harness.reset();
    resetDb();
    registerNotificationsHandlers(harness.ctx);
  });

  describe('NOTIFICATIONS_GET_PREFS', () => {
    it('returns defaults when no config keys are stored', async () => {
      const prefs = await harness.invoke(IPC.NOTIFICATIONS_GET_PREFS);
      expect(prefs).toEqual(DEFAULT_NOTIFICATION_PREFS);
    });

    it('reflects the stored values when keys are present', async () => {
      dbState.config['notifications.onWaiting'] = 'false';
      dbState.config['notifications.onBell'] = 'false';
      dbState.config['notifications.suppressWhenFocused'] = 'false';
      dbState.config['notifications.webhook.url'] = ' https://example.test/hook ';
      dbState.config['notifications.webhook.onIdle'] = 'true';
      const prefs = await harness.invoke(IPC.NOTIFICATIONS_GET_PREFS) as NotificationPrefs;
      expect(prefs.onWaiting).toBe(false);
      expect(prefs.onBell).toBe(false);
      expect(prefs.suppressWhenFocused).toBe(false);
      expect(prefs.webhook).toMatchObject({ url: 'https://example.test/hook', onIdle: true });
      // unset keys keep their defaults
      expect(prefs.onIdle).toBe(DEFAULT_NOTIFICATION_PREFS.onIdle);
      expect(prefs.onError).toBe(DEFAULT_NOTIFICATION_PREFS.onError);
    });
  });

  describe('NOTIFICATIONS_SET_PREFS', () => {
    it('persists every flag as the matching string-encoded config key and saves once', async () => {
      await harness.invoke(IPC.NOTIFICATIONS_SET_PREFS, {
        ...DEFAULT_NOTIFICATION_PREFS,
        onWaiting: false,
        onIdle: true,
        onError: false,
        onBell: true,
        suppressWhenFocused: false,
        webhook: {
          url: ' https://example.test/hook ',
          onWaiting: true,
          onIdle: true,
          onDead: true,
          onBell: false,
        },
      });
      expect(dbState.config['notifications.onWaiting']).toBe('false');
      expect(dbState.config['notifications.onIdle']).toBe('true');
      expect(dbState.config['notifications.onError']).toBe('false');
      expect(dbState.config['notifications.onBell']).toBe('true');
      expect(dbState.config['notifications.suppressWhenFocused']).toBe('false');
      expect(dbState.config['notifications.webhook.url']).toBe('https://example.test/hook');
      expect(dbState.config['notifications.webhook.onWaiting']).toBe('true');
      expect(dbState.config['notifications.webhook.onIdle']).toBe('true');
      expect(dbState.config['notifications.webhook.onDead']).toBe('true');
      expect(dbState.config['notifications.webhook.onBell']).toBe('false');
      expect(dbState.saveCount).toBe(1);
    });

    it('round-trips through GET after SET', async () => {
      const original = {
        ...DEFAULT_NOTIFICATION_PREFS,
        onWaiting: false,
        onIdle: false,
        onError: true,
        onBell: true,
        suppressWhenFocused: true,
        webhook: { url: 'https://example.test/hook', onWaiting: false, onIdle: true, onDead: true, onBell: true },
      };
      await harness.invoke(IPC.NOTIFICATIONS_SET_PREFS, original);
      expect(await harness.invoke(IPC.NOTIFICATIONS_GET_PREFS)).toEqual(original);
    });
  });

  describe('SESSION_SET_NOTIFICATIONS_MUTED', () => {
    it('forwards the (id, muted) pair to the SessionManager', async () => {
      await harness.invoke(IPC.SESSION_SET_NOTIFICATIONS_MUTED, 'sess-1', true);
      await harness.invoke(IPC.SESSION_SET_NOTIFICATIONS_MUTED, 'sess-2', false);
      expect(mutedCalls.args).toEqual([
        { id: 'sess-1', muted: true },
        { id: 'sess-2', muted: false },
      ]);
    });
  });
});
