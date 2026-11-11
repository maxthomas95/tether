import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  invoke: vi.fn(),
  send: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  getZoomLevel: vi.fn(() => 1.5),
  setZoomLevel: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (name: string, api: unknown) => { electron.exposed.set(name, api); } },
  ipcRenderer: { invoke: electron.invoke, send: electron.send, on: electron.on, removeListener: electron.removeListener },
  webFrame: { getZoomLevel: electron.getZoomLevel, setZoomLevel: electron.setZoomLevel },
}));

import { IPC } from '../shared/constants';

type Fn = (...args: unknown[]) => unknown;
interface Member { path: string; fn: Fn }

const CHANNELS = new Set<string>(Object.values(IPC));

function members(value: unknown, prefix = ''): Member[] {
  if (typeof value === 'function') return [{ path: prefix, fn: value as Fn }];
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => members(child, prefix ? `${prefix}.${key}` : key));
}

/** Subscriptions are the `onSomething` members; everything else is a request. */
function isSubscription(member: Member): boolean {
  return /^on[A-Z]/.test(member.path.split('.').at(-1) ?? '');
}

let api: Record<string, unknown>;
let all: Member[];

beforeAll(async () => {
  await import('./preload');
  api = electron.exposed.get('electronAPI') as Record<string, unknown>;
  all = members(api);
});

beforeEach(() => {
  vi.clearAllMocks();
  electron.invoke.mockResolvedValue(undefined);
});

describe('preload bridge', () => {
  it('exposes one API object and nothing else to the page', () => {
    expect([...electron.exposed.keys()]).toEqual(['electronAPI']);
    expect(api.platform).toBe(process.platform);
    expect(typeof api.homeDir).toBe('string');
    expect(all.length).toBeGreaterThan(100);
  });

  it('sends every request on a declared channel and forwards its arguments', () => {
    const requests = all.filter(member => !isSubscription(member) && !member.path.startsWith('webFrame.'));
    for (const { path, fn } of requests) {
      electron.invoke.mockClear();
      electron.send.mockClear();
      fn('first', 'second', 'third');
      const calls = [...electron.invoke.mock.calls, ...electron.send.mock.calls];
      expect(calls, path).toHaveLength(1);
      const [channel, ...forwarded] = calls[0];
      expect(CHANNELS.has(channel as string), `${path} -> ${String(channel)}`).toBe(true);
      // Arguments reach the main process in the order the page gave them.
      expect(['first', 'second', 'third'].slice(0, forwarded.length), path).toEqual(forwarded);
    }
  });

  it('hides the IPC event from subscribers and removes exactly its own listener', () => {
    const subscriptions = all.filter(isSubscription);
    expect(subscriptions.length).toBeGreaterThan(10);
    for (const { path, fn } of subscriptions) {
      electron.on.mockClear();
      electron.removeListener.mockClear();
      const callback = vi.fn();
      const unsubscribe = fn(callback) as () => void;

      expect(electron.on, path).toHaveBeenCalledOnce();
      const [channel, handler] = electron.on.mock.calls[0] as [string, Fn];
      expect(CHANNELS.has(channel), `${path} -> ${channel}`).toBe(true);

      const event = { sender: 'ipc-event' };
      handler(event, 'payload', 'detail');
      expect(callback, path).toHaveBeenCalledOnce();
      expect(callback.mock.calls[0], path).not.toContain(event);
      expect(callback.mock.calls[0][0], path).toBe('payload');

      unsubscribe();
      expect(electron.removeListener, path).toHaveBeenCalledWith(channel, handler);
    }
  });

  it('gives each request its own channel', () => {
    const seen = new Map<string, string>();
    for (const { path, fn } of all.filter(member => !isSubscription(member) && !member.path.startsWith('webFrame.'))) {
      electron.invoke.mockClear();
      electron.send.mockClear();
      fn();
      const channel = String([...electron.invoke.mock.calls, ...electron.send.mock.calls][0][0]);
      expect(seen.get(channel), `${path} shares ${channel}`).toBeUndefined();
      seen.set(channel, path);
    }
  });

  it('reads and sets zoom on the page frame without IPC', () => {
    const webFrame = api.webFrame as { getZoomLevel: () => number; setZoomLevel: (level: number) => void };
    expect(webFrame.getZoomLevel()).toBe(1.5);
    webFrame.setZoomLevel(2);
    expect(electron.setZoomLevel).toHaveBeenCalledWith(2);
    expect(electron.invoke).not.toHaveBeenCalled();
    expect(electron.send).not.toHaveBeenCalled();
  });
});
