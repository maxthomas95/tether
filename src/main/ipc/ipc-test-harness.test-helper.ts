// Shared test scaffolding for the per-domain IPC handler tests.
//
// Each handler module calls `ipcMain.handle(channel, fn)` (or `ipcMain.on`) at
// register time. This helper builds a fake `ipcMain` that captures those
// calls, plus an invoke/emit pair that lets tests fire handlers without going
// through Electron's real IPC.
//
// Usage (the registry must be hoisted because vi.mock factories run before
// imports, but the rest of the harness can be plain top-level):
//
//   const registry = vi.hoisted(() => ({
//     handlers: new Map(),
//     listeners: new Map(),
//   }));
//   vi.mock('electron', () => ({
//     ipcMain: {
//       handle: (ch, fn) => { registry.handlers.set(ch, fn); },
//       on: (ch, fn) => { registry.listeners.set(ch, fn); },
//     },
//     // ...other electron stubs the SUT needs
//   }));
//   import { createHarness } from './ipc-test-harness.test-helper';
//   const harness = createHarness(registry);

import { vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { HandlerContext } from './helpers';

export interface IpcRegistry {
  handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>;
  listeners: Map<string, (event: unknown, ...args: unknown[]) => void>;
}

/**
 * The base `electron` module shape needed by every IPC handler test —
 * `ipcMain.handle` / `ipcMain.on` capture into the supplied registry. Test
 * files spread this into their `vi.mock('electron', ...)` factory and add any
 * extra electron exports their SUT needs (`dialog`, `shell`, `safeStorage`,
 * `app`, etc.).
 */
export function makeElectronMockBase(registry: IpcRegistry): { ipcMain: { handle: (ch: string, fn: (event: unknown, ...args: unknown[]) => unknown) => void; on: (ch: string, fn: (event: unknown, ...args: unknown[]) => void) => void } } {
  return {
    ipcMain: {
      handle: (ch, fn) => { registry.handlers.set(ch, fn); },
      on: (ch, fn) => { registry.listeners.set(ch, fn); },
    },
  };
}

export interface IpcHarness {
  ctx: HandlerContext;
  send: ReturnType<typeof vi.fn>;
  /** Invoke an `ipcMain.handle` handler. Returns the awaited result. */
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
  /** Invoke an `ipcMain.on` handler. */
  emit(channel: string, ...args: unknown[]): void;
  /** Clear captured registrations + the send spy between tests. */
  reset: () => void;
}

export function createHarness(registry: IpcRegistry): IpcHarness {
  const send = vi.fn();
  const fakeWindow = {
    isDestroyed: () => false,
    webContents: { send: vi.fn() },
    setTitleBarOverlay: vi.fn(),
  } as unknown as BrowserWindow;

  const ctx: HandlerContext = {
    mainWindow: fakeWindow,
    send: (channel, ...args) => send(channel, ...args),
  };

  async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    const fn = registry.handlers.get(channel);
    if (!fn) throw new Error(`No ipcMain.handle registered for ${channel}`);
    return await fn({}, ...args) as T;
  }

  function emit(channel: string, ...args: unknown[]): void {
    const fn = registry.listeners.get(channel);
    if (!fn) throw new Error(`No ipcMain.on registered for ${channel}`);
    fn({}, ...args);
  }

  function reset() {
    registry.handlers.clear();
    registry.listeners.clear();
    send.mockReset();
  }

  return { ctx, send, invoke, emit, reset };
}
