import { afterEach, beforeEach, vi } from 'vitest';
import type { TransportStartOptions } from './types';

const ptySpawnSpy = vi.hoisted(() => vi.fn());

vi.mock('./pty-loader', () => ({
  loadPty: () => ({ spawn: ptySpawnSpy }),
}));

export function getPtySpawnSpy() {
  return ptySpawnSpy;
}

interface PtyExitInfo {
  exitCode: number;
  signal?: number;
}

export interface FakePty {
  pid: number;
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  onData: (cb: (data: string) => void) => { dispose: ReturnType<typeof vi.fn> };
  onExit: (cb: (info: PtyExitInfo) => void) => { dispose: ReturnType<typeof vi.fn> };
  emitData: (data: string) => void;
  emitExit: (info: PtyExitInfo) => void;
}

export function createPtyHarness(spawnSpy: ReturnType<typeof vi.fn>) {
  let current: FakePty | null = null;

  function makePty(): FakePty {
    let dataCb: ((data: string) => void) | null = null;
    let exitCb: ((info: PtyExitInfo) => void) | null = null;

    return {
      pid: 1234,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData(cb: (data: string) => void) {
        dataCb = cb;
        return { dispose: vi.fn() };
      },
      onExit(cb: (info: PtyExitInfo) => void) {
        exitCb = cb;
        return { dispose: vi.fn() };
      },
      emitData(data: string) {
        dataCb?.(data);
      },
      emitExit(info: PtyExitInfo) {
        exitCb?.(info);
      },
    };
  }

  spawnSpy.mockImplementation(() => {
    current = makePty();
    return current;
  });

  return {
    get current(): FakePty | null {
      return current;
    },
    reset() {
      current = null;
      spawnSpy.mockClear();
    },
  };
}

export function createPlatformHarness() {
  let originalPlatform: PropertyDescriptor | undefined;

  return {
    capture() {
      originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    },
    restore() {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform);
      }
      originalPlatform = undefined;
    },
    set(platform: NodeJS.Platform) {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    },
  };
}

export function baseTransportOptions(
  workingDir: string,
  overrides: Partial<TransportStartOptions> = {},
): TransportStartOptions {
  return {
    workingDir,
    env: {},
    cols: 80,
    rows: 24,
    cliArgs: [],
    cliTool: 'claude',
    binaryName: 'claude',
    ...overrides,
  };
}

export function createTransportOptions(workingDir: string) {
  return (overrides: Partial<TransportStartOptions> = {}): TransportStartOptions => (
    baseTransportOptions(workingDir, overrides)
  );
}

export function setupPtyTransportTest() {
  const ptyHarness = createPtyHarness(ptySpawnSpy);
  const platform = createPlatformHarness();

  beforeEach(() => {
    ptyHarness.reset();
    platform.capture();
  });

  afterEach(() => {
    platform.restore();
  });

  return { ptyHarness, platform };
}
