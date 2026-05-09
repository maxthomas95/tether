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

import { CoderTransport } from './coder-transport';

function baseOptions(overrides: Partial<TransportStartOptions> = {}): TransportStartOptions {
  return {
    workingDir: 'workspace1',
    env: {},
    cols: 80,
    rows: 24,
    cliArgs: [],
    cliTool: 'claude',
    binaryName: 'claude',
    ...overrides,
  };
}

describe('CoderTransport', () => {
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

  it('uses the default `coder` binary when none configured', async () => {
    setPlatform('linux');
    await new CoderTransport().start(baseOptions());
    const [file] = ptyHarness.spawnSpy.mock.calls[0];
    expect(file).toBe('coder');
  });

  it('uses an overridden binaryPath when provided', async () => {
    setPlatform('linux');
    await new CoderTransport({ binaryPath: '/usr/local/bin/coder-cli' }).start(baseOptions());
    const [file] = ptyHarness.spawnSpy.mock.calls[0];
    expect(file).toBe('/usr/local/bin/coder-cli');
  });

  it('throws when workingDir is empty', async () => {
    setPlatform('linux');
    await expect(new CoderTransport().start(baseOptions({ workingDir: '   ' }))).rejects.toThrow(/workspace name/);
  });

  it('parses workspace::subdir form into workspace name + subdir cd', async () => {
    setPlatform('linux');
    await new CoderTransport().start(baseOptions({ workingDir: 'ws-prod::repos/tether' }));
    const [, args] = ptyHarness.spawnSpy.mock.calls[0];
    expect(args).toEqual(['ssh', 'ws-prod']);
    // Subdir gets cd'd into via the optimistic write to the PTY
    const writes = ptyHarness.current!.write.mock.calls.map((c) => c[0]).join('');
    expect(writes).toContain("cd 'repos/tether'");
  });

  it('does not emit a cd step for bare workspace names', async () => {
    setPlatform('linux');
    await new CoderTransport().start(baseOptions({ workingDir: 'ws-prod' }));
    const [, args] = ptyHarness.spawnSpy.mock.calls[0];
    expect(args).toEqual(['ssh', 'ws-prod']);
    const writes = ptyHarness.current!.write.mock.calls.map((c) => c[0]).join('');
    expect(writes).not.toContain('cd ');
  });

  it('on win32, wraps the binary in cmd.exe /c', async () => {
    setPlatform('win32');
    await new CoderTransport().start(baseOptions({ workingDir: 'ws' }));
    const [file, args] = ptyHarness.spawnSpy.mock.calls[0];
    expect(file).toBe('cmd.exe');
    expect(args).toEqual(['/c', 'coder', 'ssh', 'ws']);
  });

  it('preserves a leading ~ in the subdir path (for remote shell expansion)', async () => {
    setPlatform('linux');
    await new CoderTransport().start(baseOptions({ workingDir: 'ws::~/code/foo' }));
    const writes = ptyHarness.current!.write.mock.calls.map((c) => c[0]).join('');
    // ~ stays unquoted, the rest gets shell-quoted
    expect(writes).toContain("cd ~/'code/foo'");
  });

  it('shell-escapes env values with single quotes', async () => {
    setPlatform('linux');
    await new CoderTransport().start(baseOptions({
      workingDir: 'ws',
      env: { TRICKY: "it's $weird" },
    }));
    const writes = ptyHarness.current!.write.mock.calls.map((c) => c[0]).join('');
    // Each ' inside the value becomes '\''
    expect(writes).toContain(`TRICKY='it'\\''s $weird'`);
  });

  it('issues a guarded git clone when cloneUrl + subdir set, skipping if dir exists', async () => {
    setPlatform('linux');
    await new CoderTransport().start(baseOptions({
      workingDir: 'ws::repos/proj',
      cloneUrl: 'https://github.com/example/proj.git',
    }));
    const writes = ptyHarness.current!.write.mock.calls.map((c) => c[0]).join('');
    expect(writes).toContain("[ -d 'repos/proj' ] || git clone 'https://github.com/example/proj.git' 'repos/proj'");
  });

  it('passes initialPrompt as a single shell-escaped positional arg', async () => {
    setPlatform('linux');
    await new CoderTransport().start(baseOptions({
      workingDir: 'ws',
      initialPrompt: 'fix it pls',
    }));
    const writes = ptyHarness.current!.write.mock.calls.map((c) => c[0]).join('');
    expect(writes).toContain("claude 'fix it pls'");
  });

  it('fans onData / onExit and dispose clears callbacks', async () => {
    setPlatform('linux');
    const t = new CoderTransport();
    const dataCb = vi.fn();
    const exitCb = vi.fn();
    t.onData(dataCb);
    t.onExit(exitCb);
    await t.start(baseOptions());

    ptyHarness.current!.emitData('hello');
    expect(dataCb).toHaveBeenCalledWith('hello');

    t.dispose();
    ptyHarness.current!.emitExit({ exitCode: 0 });
    expect(exitCb).not.toHaveBeenCalled();
  });

  it('write / resize delegate to the PTY; kill flips connected', async () => {
    setPlatform('linux');
    const t = new CoderTransport();
    await t.start(baseOptions());
    const captured = ptyHarness.current!;

    t.write('x');
    expect(captured.write).toHaveBeenCalledWith('x');
    t.resize(100, 30);
    expect(captured.resize).toHaveBeenCalledWith(100, 30);
    expect(t.connected).toBe(true);
    t.kill();
    expect(captured.kill).toHaveBeenCalled();
    expect(t.connected).toBe(false);
  });
});
