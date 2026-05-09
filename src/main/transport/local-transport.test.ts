import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { TransportStartOptions } from './types';

interface FakePty {
  pid: number;
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  emitData: (data: string) => void;
  emitExit: (info: { exitCode: number; signal?: number }) => void;
}

const ptyHarness = vi.hoisted(() => {
  let current: FakePty | null = null;
  const spawnSpy = vi.fn();

  function makePty(): FakePty {
    let dataCb: ((data: string) => void) | null = null;
    let exitCb: ((info: { exitCode: number; signal?: number }) => void) | null = null;
    return {
      pid: 1234,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData(cb: (data: string) => void) { dataCb = cb; return { dispose: vi.fn() }; },
      onExit(cb: (info: { exitCode: number; signal?: number }) => void) { exitCb = cb; return { dispose: vi.fn() }; },
      emitData(data: string) { dataCb?.(data); },
      emitExit(info: { exitCode: number; signal?: number }) { exitCb?.(info); },
    } as unknown as FakePty;
  }

  return {
    spawnSpy,
    spawn(...args: unknown[]) {
      spawnSpy(...args);
      current = makePty();
      return current;
    },
    get current(): FakePty | null { return current; },
    reset() { current = null; spawnSpy.mockReset(); },
  };
});

vi.mock('./pty-loader', () => ({
  loadPty: () => ({ spawn: ptyHarness.spawn }),
}));

import { LocalTransport } from './local-transport';

function baseOptions(overrides: Partial<TransportStartOptions> = {}): TransportStartOptions {
  return {
    workingDir: 'C:\\repo\\tether',
    env: {},
    cols: 80,
    rows: 24,
    cliArgs: [],
    cliTool: 'claude',
    binaryName: 'claude',
    ...overrides,
  };
}

describe('LocalTransport', () => {
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    ptyHarness.reset();
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  });

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  function setPlatform(p: NodeJS.Platform) {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
  }

  it('reports not connected before start', () => {
    expect(new LocalTransport().connected).toBe(false);
  });

  it('reports connected after a successful start', async () => {
    setPlatform('linux');
    const t = new LocalTransport();
    await t.start(baseOptions());
    expect(t.connected).toBe(true);
  });

  it('on win32, wraps the binary in cmd.exe /c', async () => {
    setPlatform('win32');
    await new LocalTransport().start(baseOptions({ binaryName: 'claude' }));
    const [file, args] = ptyHarness.spawnSpy.mock.calls[0];
    expect(file).toBe('cmd.exe');
    expect(args).toEqual(['/c', 'claude']);
  });

  it('on POSIX, spawns the binary directly', async () => {
    setPlatform('linux');
    await new LocalTransport().start(baseOptions({ binaryName: 'claude' }));
    const [file, args] = ptyHarness.spawnSpy.mock.calls[0];
    expect(file).toBe('claude');
    expect(args).toEqual([]);
  });

  it('tokenizes multi-token cliArgs entries on whitespace', async () => {
    setPlatform('linux');
    await new LocalTransport().start(baseOptions({
      cliArgs: ['--permission-mode plan', '--model', 'sonnet'],
    }));
    const [, args] = ptyHarness.spawnSpy.mock.calls[0];
    expect(args).toEqual(['--permission-mode', 'plan', '--model', 'sonnet']);
  });

  it('appends initialPrompt as a single un-tokenized arg', async () => {
    setPlatform('linux');
    await new LocalTransport().start(baseOptions({
      cliArgs: ['--model', 'sonnet'],
      initialPrompt: 'fix the bug in foo bar',
    }));
    const [, args] = ptyHarness.spawnSpy.mock.calls[0];
    expect(args).toEqual(['--model', 'sonnet', 'fix the bug in foo bar']);
  });

  it('passes claudeSessionId through buildCliArgsForTool as --session-id', async () => {
    setPlatform('linux');
    await new LocalTransport().start(baseOptions({
      cliTool: 'claude',
      claudeSessionId: 'abc-123',
    }));
    const [, args] = ptyHarness.spawnSpy.mock.calls[0];
    expect(args).toContain('--session-id');
    expect(args).toContain('abc-123');
  });

  it('passes resumeClaudeSessionId as --resume (not --session-id)', async () => {
    setPlatform('linux');
    await new LocalTransport().start(baseOptions({
      cliTool: 'claude',
      claudeSessionId: 'abc-123',
      resumeClaudeSessionId: 'old-456',
    }));
    const [, args] = ptyHarness.spawnSpy.mock.calls[0];
    expect(args).toContain('--resume');
    expect(args).toContain('old-456');
    expect(args).not.toContain('--session-id');
  });

  it('merges options.env into spawn env without dropping process.env', async () => {
    setPlatform('linux');
    process.env.SHOULD_BE_PRESENT = 'yes';
    try {
      await new LocalTransport().start(baseOptions({
        env: { CUSTOM_VAR: 'hello' },
      }));
      const [, , spawnOpts] = ptyHarness.spawnSpy.mock.calls[0];
      expect(spawnOpts.env.CUSTOM_VAR).toBe('hello');
      expect(spawnOpts.env.SHOULD_BE_PRESENT).toBe('yes');
      expect(spawnOpts.env.TERM).toBe('xterm-256color');
      expect(spawnOpts.env.COLORTERM).toBe('truecolor');
    } finally {
      delete process.env.SHOULD_BE_PRESENT;
    }
  });

  it('passes cwd / cols / rows through to spawn', async () => {
    setPlatform('linux');
    await new LocalTransport().start(baseOptions({
      workingDir: '/home/me/repo',
      cols: 132,
      rows: 50,
    }));
    const [, , spawnOpts] = ptyHarness.spawnSpy.mock.calls[0];
    expect(spawnOpts.cwd).toBe('/home/me/repo');
    expect(spawnOpts.cols).toBe(132);
    expect(spawnOpts.rows).toBe(50);
  });

  it('fans PTY data out to all onData listeners', async () => {
    setPlatform('linux');
    const t = new LocalTransport();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    t.onData(cb1);
    t.onData(cb2);
    await t.start(baseOptions());

    ptyHarness.current!.emitData('hello');
    expect(cb1).toHaveBeenCalledWith('hello');
    expect(cb2).toHaveBeenCalledWith('hello');
  });

  it('flips connected to false and fans onExit on PTY exit', async () => {
    setPlatform('linux');
    const t = new LocalTransport();
    const cb = vi.fn();
    t.onExit(cb);
    await t.start(baseOptions());
    expect(t.connected).toBe(true);

    ptyHarness.current!.emitExit({ exitCode: 0, signal: 15 });
    expect(t.connected).toBe(false);
    expect(cb).toHaveBeenCalledWith({ exitCode: 0, signal: '15' });
  });

  it('write delegates to PTY when started', async () => {
    setPlatform('linux');
    const t = new LocalTransport();
    await t.start(baseOptions());
    t.write('input');
    expect(ptyHarness.current!.write).toHaveBeenCalledWith('input');
  });

  it('write is a no-op when not started', () => {
    expect(() => new LocalTransport().write('x')).not.toThrow();
  });

  it('resize delegates to PTY', async () => {
    setPlatform('linux');
    const t = new LocalTransport();
    await t.start(baseOptions());
    t.resize(120, 40);
    expect(ptyHarness.current!.resize).toHaveBeenCalledWith(120, 40);
  });

  it('resize swallows errors when PTY has exited', async () => {
    setPlatform('linux');
    const t = new LocalTransport();
    await t.start(baseOptions());
    ptyHarness.current!.resize = vi.fn(() => { throw new Error('PTY exited'); });
    expect(() => t.resize(80, 24)).not.toThrow();
  });

  it('kill nulls the PTY and flips connected', async () => {
    setPlatform('linux');
    const t = new LocalTransport();
    await t.start(baseOptions());
    const captured = ptyHarness.current!;
    t.kill();
    expect(captured.kill).toHaveBeenCalled();
    expect(t.connected).toBe(false);
  });

  it('dispose clears callbacks so post-dispose events do nothing', async () => {
    setPlatform('linux');
    const t = new LocalTransport();
    const dataCb = vi.fn();
    const exitCb = vi.fn();
    t.onData(dataCb);
    t.onExit(exitCb);
    await t.start(baseOptions());
    const captured = ptyHarness.current!;

    t.dispose();
    captured.emitData('after dispose');
    captured.emitExit({ exitCode: 0 });
    expect(dataCb).not.toHaveBeenCalled();
    expect(exitCb).not.toHaveBeenCalled();
  });
});
