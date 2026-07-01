import { describe, it, expect, vi } from 'vitest';
import { createTransportOptions, getPtySpawnSpy, setupPtyTransportTest } from './transport-test-utils.test-helper';

import { LocalTransport } from './local-transport';

const baseOptions = createTransportOptions('C:\\repo\\tether');
const ptySpawnSpy = getPtySpawnSpy();

describe('LocalTransport', () => {
  const { ptyHarness, platform } = setupPtyTransportTest();

  it('reports not connected before start', () => {
    expect(new LocalTransport().connected).toBe(false);
  });

  it('reports connected after a successful start', async () => {
    platform.set('linux');
    const t = new LocalTransport();
    await t.start(baseOptions());
    expect(t.connected).toBe(true);
  });

  it('on win32, wraps the binary in cmd.exe /c', async () => {
    platform.set('win32');
    await new LocalTransport().start(baseOptions({ binaryName: 'claude' }));
    const [file, args] = ptySpawnSpy.mock.calls[0];
    expect(file).toBe('cmd.exe');
    expect(args).toEqual(['/d', '/c', 'claude']);
  });

  it('on win32, rejects unsafe command-position binary values', async () => {
    platform.set('win32');
    await expect(new LocalTransport().start(baseOptions({ binaryName: 'claude&calc' })))
      .rejects.toThrow(/unsafe/);
    expect(ptySpawnSpy).not.toHaveBeenCalled();
  });

  it('on win32, escapes cmd.exe expansion metacharacters in args', async () => {
    platform.set('win32');
    await new LocalTransport().start(baseOptions({
      binaryName: 'claude',
      cliArgs: ['--model', 'sonnet%PATH%', 'caret^x', 'fix&calc'],
    }));
    const [, args] = ptySpawnSpy.mock.calls[0];
    expect(args).toEqual(['/d', '/c', 'claude', '--model', 'sonnet^%PATH^%', 'caret^^x', 'fix^&calc']);
  });

  it('on POSIX, spawns the binary directly', async () => {
    platform.set('linux');
    await new LocalTransport().start(baseOptions({ binaryName: 'claude' }));
    const [file, args] = ptySpawnSpy.mock.calls[0];
    expect(file).toBe('claude');
    expect(args).toEqual([]);
  });

  it('tokenizes multi-token cliArgs entries on whitespace', async () => {
    platform.set('linux');
    await new LocalTransport().start(baseOptions({
      cliArgs: ['--permission-mode plan', '--model', 'sonnet'],
    }));
    const [, args] = ptySpawnSpy.mock.calls[0];
    expect(args).toEqual(['--permission-mode', 'plan', '--model', 'sonnet']);
  });

  it('preserves equals-form args that contain spaces', async () => {
    platform.set('linux');
    await new LocalTransport().start(baseOptions({
      cliArgs: ['--mcp-config=C:\\Users\\Max Thomas\\AppData\\config.json'],
    }));
    const [, args] = ptySpawnSpy.mock.calls[0];
    expect(args).toEqual(['--mcp-config=C:\\Users\\Max Thomas\\AppData\\config.json']);
  });

  it('appends initialPrompt as a single un-tokenized arg', async () => {
    platform.set('linux');
    await new LocalTransport().start(baseOptions({
      cliArgs: ['--model', 'sonnet'],
      initialPrompt: 'fix the bug in foo bar',
    }));
    const [, args] = ptySpawnSpy.mock.calls[0];
    expect(args).toEqual(['--model', 'sonnet', 'fix the bug in foo bar']);
  });

  it('passes claudeSessionId through buildCliArgsForTool as --session-id', async () => {
    platform.set('linux');
    await new LocalTransport().start(baseOptions({
      cliTool: 'claude',
      claudeSessionId: 'abc-123',
    }));
    const [, args] = ptySpawnSpy.mock.calls[0];
    expect(args).toContain('--session-id');
    expect(args).toContain('abc-123');
  });

  it('passes resumeClaudeSessionId as --resume (not --session-id)', async () => {
    platform.set('linux');
    await new LocalTransport().start(baseOptions({
      cliTool: 'claude',
      claudeSessionId: 'abc-123',
      resumeClaudeSessionId: 'old-456',
    }));
    const [, args] = ptySpawnSpy.mock.calls[0];
    expect(args).toContain('--resume');
    expect(args).toContain('old-456');
    expect(args).not.toContain('--session-id');
  });

  it('merges options.env into spawn env without dropping process.env', async () => {
    platform.set('linux');
    process.env.SHOULD_BE_PRESENT = 'yes';
    try {
      await new LocalTransport().start(baseOptions({
        env: { CUSTOM_VAR: 'hello' },
      }));
      const [, , spawnOpts] = ptySpawnSpy.mock.calls[0];
      expect(spawnOpts.env.CUSTOM_VAR).toBe('hello');
      expect(spawnOpts.env.SHOULD_BE_PRESENT).toBe('yes');
      expect(spawnOpts.env.TERM).toBe('xterm-256color');
      expect(spawnOpts.env.COLORTERM).toBe('truecolor');
    } finally {
      delete process.env.SHOULD_BE_PRESENT;
    }
  });

  it('injects IS_SANDBOX=1 when the local user is root (POSIX) and Claude skips permissions', async () => {
    platform.set('linux');
    const originalGetuid = process.getuid;
    process.getuid = () => 0;
    try {
      await new LocalTransport().start(baseOptions({
        cliArgs: ['--dangerously-skip-permissions'],
      }));
      const [, , spawnOpts] = ptySpawnSpy.mock.calls[0];
      expect(spawnOpts.env.IS_SANDBOX).toBe('1');
    } finally {
      process.getuid = originalGetuid;
    }
  });

  it('does not inject IS_SANDBOX when the local user is not root', async () => {
    platform.set('linux');
    const originalGetuid = process.getuid;
    process.getuid = () => 1000;
    try {
      await new LocalTransport().start(baseOptions({
        cliArgs: ['--dangerously-skip-permissions'],
      }));
      const [, , spawnOpts] = ptySpawnSpy.mock.calls[0];
      expect(spawnOpts.env.IS_SANDBOX).toBeUndefined();
    } finally {
      process.getuid = originalGetuid;
    }
  });

  it('passes cwd / cols / rows through to spawn', async () => {
    platform.set('linux');
    await new LocalTransport().start(baseOptions({
      workingDir: '/home/me/repo',
      cols: 132,
      rows: 50,
    }));
    const [, , spawnOpts] = ptySpawnSpy.mock.calls[0];
    expect(spawnOpts.cwd).toBe('/home/me/repo');
    expect(spawnOpts.cols).toBe(132);
    expect(spawnOpts.rows).toBe(50);
  });

  it('fans PTY data out to all onData listeners', async () => {
    platform.set('linux');
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
    platform.set('linux');
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
    platform.set('linux');
    const t = new LocalTransport();
    await t.start(baseOptions());
    t.write('input');
    expect(ptyHarness.current!.write).toHaveBeenCalledWith('input');
  });

  it('write is a no-op when not started', () => {
    expect(() => new LocalTransport().write('x')).not.toThrow();
  });

  it('resize delegates to PTY', async () => {
    platform.set('linux');
    const t = new LocalTransport();
    await t.start(baseOptions());
    t.resize(120, 40);
    expect(ptyHarness.current!.resize).toHaveBeenCalledWith(120, 40);
  });

  it('resize swallows errors when PTY has exited', async () => {
    platform.set('linux');
    const t = new LocalTransport();
    await t.start(baseOptions());
    ptyHarness.current!.resize = vi.fn(() => { throw new Error('PTY exited'); });
    expect(() => t.resize(80, 24)).not.toThrow();
  });

  it('kill nulls the PTY and flips connected', async () => {
    platform.set('linux');
    const t = new LocalTransport();
    await t.start(baseOptions());
    const captured = ptyHarness.current!;
    t.kill();
    expect(captured.kill).toHaveBeenCalled();
    expect(t.connected).toBe(false);
  });

  it('dispose clears callbacks so post-dispose events do nothing', async () => {
    platform.set('linux');
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
