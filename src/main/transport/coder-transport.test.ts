import { decodeLaunchPayload } from './remote-bootstrap.test-helper';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { bootstrapReady } from './remote-bootstrap.test-helper';
import { createTransportOptions, getPtySpawnSpy, setupPtyTransportTest } from './transport-test-utils.test-helper';

// See local-transport.test.ts: mock resolution so win32 branch tests are
// host-independent. process.execPath resolves "direct"; anything else is an
// unresolved shell launch. Real resolution is covered by its own unit test.
vi.mock('./win-binary-resolver', () => ({
  resolveWindowsLaunch: (binary: string) =>
    binary === process.execPath
      ? { kind: 'direct', file: binary }
      : { kind: 'shell', file: binary },
}));

import { CoderTransport } from './coder-transport';

const baseOptions = createTransportOptions('workspace1');
const ptySpawnSpy = getPtySpawnSpy();

describe('CoderTransport', () => {
  afterEach(() => vi.useRealTimers());
  it('sends no launch data until the echo-off marker and preserves every output byte', async () => {
    platform.set('linux'); ptyHarness.setAutoReady(false);
    const transport = new CoderTransport(); const output = vi.fn(); transport.onData(output);
    const starting = transport.start(baseOptions({ env: { CONNECTION_STRING: 'Password=fixture-secret' } }));
    const process = ptyHarness.current!;
    expect(process.write).toHaveBeenCalledOnce();
    const first = process.write.mock.calls[0][0];
    expect(first).not.toContain('fixture-secret');
    const marker = bootstrapReady(first)!;
    process.emitData('login prompt and command echo');
    process.emitData(marker.slice(0, 13));
    expect(process.write).toHaveBeenCalledOnce();
    process.emitData(marker.slice(13)); await starting;
    expect(decodeLaunchPayload(process.write.mock.calls)).toContain('Password=fixture-secret');
    expect(output.mock.calls.map(call => call[0]).join('')).toBe('login prompt and command echo' + marker);
    transport.dispose();
  });

  it('times out and tears down without sending credentials when echo-off never succeeds', async () => {
    platform.set('linux'); ptyHarness.setAutoReady(false); vi.useFakeTimers();
    const transport = new CoderTransport();
    const rejected = expect(transport.start(baseOptions({ env: { TOKEN: 'fixture-secret' } }))).rejects.toThrow('timed out');
    const process = ptyHarness.current!;
    await vi.advanceTimersByTimeAsync(15_000); await rejected;
    expect(process.write).toHaveBeenCalledOnce(); expect(process.kill).toHaveBeenCalledOnce();
    expect(transport.connected).toBe(false);
  });

  it('rejects pending setup when the PTY exits or the session is cancelled', async () => {
    platform.set('linux'); ptyHarness.setAutoReady(false);
    const transport = new CoderTransport(); const starting = transport.start(baseOptions());
    const rejected = expect(starting).rejects.toThrow('exited');
    ptyHarness.current!.emitExit({ exitCode: 1 }); await rejected;
    const next = transport.start(baseOptions()); const cancelled = expect(next).rejects.toThrow('cancelled');
    transport.kill(); await cancelled;
  });
  it('exits maintenance shells with the command status and preserves exact argv', async () => {
    platform.set('linux');
    await new CoderTransport().start(baseOptions({ cliTool: 'claude', toolSessionId: 'ignored',
      command: { file: 'tool', args: ['--home', '/path with spaces', 'update'] }, exitAfterCommand: true }));
    const writes = decodeLaunchPayload(ptyHarness.current!.write.mock.calls);
    expect(writes).toContain(`'tool' '--home' '/path with spaces' 'update'; tether_status=$?; exit "$tether_status"`);
  });
  const { ptyHarness, platform } = setupPtyTransportTest();

  it('uses the default `coder` binary when none configured', async () => {
    platform.set('linux');
    await new CoderTransport().start(baseOptions());
    const [file] = ptySpawnSpy.mock.calls[0];
    expect(file).toBe('coder');
    expect(ptySpawnSpy.mock.calls[0][2].useConptyDll).toBeUndefined();
  });

  it('uses an overridden binaryPath when provided', async () => {
    platform.set('linux');
    await new CoderTransport({ binaryPath: '/usr/local/bin/coder-cli' }).start(baseOptions());
    const [file] = ptySpawnSpy.mock.calls[0];
    expect(file).toBe('/usr/local/bin/coder-cli');
  });

  it('throws when workingDir is empty', async () => {
    platform.set('linux');
    await expect(new CoderTransport().start(baseOptions({ workingDir: '   ' }))).rejects.toThrow(/workspace name/);
  });

  it('parses workspace::subdir form into workspace name + subdir cd', async () => {
    platform.set('linux');
    await new CoderTransport().start(baseOptions({ workingDir: 'ws-prod::repos/tether' }));
    const [, args] = ptySpawnSpy.mock.calls[0];
    expect(args).toEqual(['ssh', 'ws-prod']);
    // Subdir gets cd'd into via the optimistic write to the PTY
    const writes = decodeLaunchPayload(ptyHarness.current!.write.mock.calls);
    expect(writes).toContain("cd 'repos/tether'");
  });

  it('does not emit a cd step for bare workspace names', async () => {
    platform.set('linux');
    await new CoderTransport().start(baseOptions({ workingDir: 'ws-prod' }));
    const [, args] = ptySpawnSpy.mock.calls[0];
    expect(args).toEqual(['ssh', 'ws-prod']);
    const writes = decodeLaunchPayload(ptyHarness.current!.write.mock.calls);
    expect(writes).not.toContain('cd ');
  });

  it.each(['claude', 'codex'] as const)('launches %s with the exact resume id inside its workspace', async cliTool => {
    platform.set('linux');
    await new CoderTransport().start(baseOptions({ workingDir: 'ws::/work', cliTool, binaryName: cliTool,
      toolSessionId: 'saved-id', resumeToolSessionId: 'saved-id' }));
    const writes = decodeLaunchPayload(ptyHarness.current!.write.mock.calls);
    expect(writes).toContain("cd '/work'");
    expect(writes).toContain(cliTool === 'claude'
      ? "'claude' '--resume' 'saved-id'" : "'codex' 'resume' 'saved-id'");
    expect(writes).not.toContain('--session-id');
    expect(writes).not.toContain('--last');
  });

  it('on win32, launches a resolved executable directly', async () => {
    platform.set('win32');
    await new CoderTransport({ binaryPath: process.execPath }).start(baseOptions({ workingDir: 'ws' }));
    const [file, args] = ptySpawnSpy.mock.calls[0];
    expect(file).toBe(process.execPath);
    expect(args).toEqual(['ssh', 'ws']);
    expect(ptySpawnSpy.mock.calls[0][2].useConptyDll).toBe(true);
  });

  it('on win32, uses cmd.exe for an unresolved command', async () => {
    platform.set('win32');
    await new CoderTransport({ binaryPath: 'tether-test-missing-coder' }).start(baseOptions({ workingDir: 'ws' }));
    const [file, args] = ptySpawnSpy.mock.calls[0];
    expect(file).toBe('cmd.exe');
    expect(args).toEqual(['/d', '/c', 'tether-test-missing-coder', 'ssh', 'ws']);
  });

  it('on win32, rejects unsafe coder binary values', async () => {
    platform.set('win32');
    await expect(new CoderTransport({ binaryPath: 'coder&calc' }).start(baseOptions({ workingDir: 'ws' })))
      .rejects.toThrow(/unsafe/);
    expect(ptySpawnSpy).not.toHaveBeenCalled();
  });

  it('on win32, escapes workspace names before passing through cmd.exe', async () => {
    platform.set('win32');
    await new CoderTransport({ binaryPath: 'tether-test-missing-coder' }).start(baseOptions({ workingDir: 'ws%PATH%&calc' }));
    const [, args] = ptySpawnSpy.mock.calls[0];
    expect(args).toEqual(['/d', '/c', 'tether-test-missing-coder', 'ssh', 'ws^%PATH^%^&calc']);
  });

  it('on win32, rejects quoted workspace names for the batch-shim fallback', async () => {
    platform.set('win32');
    await expect(new CoderTransport({ binaryPath: 'tether-test-missing-coder' }).start(baseOptions({
      workingDir: 'ws"name',
    }))).rejects.toThrow(/double quotes/);
    expect(ptySpawnSpy).not.toHaveBeenCalled();
  });
  it('preserves a leading ~ in the subdir path (for remote shell expansion)', async () => {
    platform.set('linux');
    await new CoderTransport().start(baseOptions({ workingDir: 'ws::~/code/foo' }));
    const writes = decodeLaunchPayload(ptyHarness.current!.write.mock.calls);
    // ~ stays unquoted, the rest gets shell-quoted
    expect(writes).toContain("cd ~/'code/foo'");
  });

  it('shell-escapes env values with single quotes', async () => {
    platform.set('linux');
    await new CoderTransport().start(baseOptions({
      workingDir: 'ws',
      env: { TRICKY: "it's $weird" },
    }));
    const writes = decodeLaunchPayload(ptyHarness.current!.write.mock.calls);
    // The whole NAME=value pair is one argv word to env(1).
    expect(writes).toContain(`'TRICKY=it'\\''s $weird'`);
  });

  it('rejects invalid env names before spawning coder ssh', async () => {
    platform.set('linux');
    await expect(new CoderTransport().start(baseOptions({
      workingDir: 'ws',
      env: { 'BAD-NAME': 'x' },
    }))).rejects.toThrow(/Invalid environment variable name/);
    expect(ptySpawnSpy).not.toHaveBeenCalled();
  });

  it('issues a guarded git clone when cloneUrl + subdir set, skipping if dir exists', async () => {
    platform.set('linux');
    await new CoderTransport().start(baseOptions({
      workingDir: 'ws::repos/proj',
      cloneUrl: 'https://github.com/example/proj.git',
    }));
    const writes = decodeLaunchPayload(ptyHarness.current!.write.mock.calls);
    expect(writes).toContain("[ -d 'repos/proj' ] || GIT_ALLOW_PROTOCOL=https:ssh git clone -- 'https://github.com/example/proj.git' 'repos/proj'");
  });

  it('rejects unsafe clone URLs before spawning coder ssh', async () => {
    platform.set('linux');
    await expect(new CoderTransport().start(baseOptions({
      workingDir: 'ws::repos/proj',
      cloneUrl: 'ext::sh -c calc',
    }))).rejects.toThrow(/not allowed/);
    expect(ptySpawnSpy).not.toHaveBeenCalled();
  });

  it('passes initialPrompt as a single shell-escaped positional arg', async () => {
    platform.set('linux');
    await new CoderTransport().start(baseOptions({
      workingDir: 'ws',
      initialPrompt: 'fix it pls',
    }));
    const writes = decodeLaunchPayload(ptyHarness.current!.write.mock.calls);
    expect(writes).toContain("'claude' 'fix it pls'");
  });

  it('fans onData / onExit and dispose clears callbacks', async () => {
    platform.set('linux');
    const t = new CoderTransport();
    const dataCb = vi.fn();
    const exitCb = vi.fn();
    t.onData(dataCb);
    t.onExit(exitCb);
    await t.start(baseOptions());

    dataCb.mockClear();
    ptyHarness.current!.emitData('hello');
    expect(dataCb).toHaveBeenCalledWith('hello');

    t.dispose();
    ptyHarness.current!.emitExit({ exitCode: 0 });
    expect(exitCb).not.toHaveBeenCalled();
  });

  it('write / resize delegate to the PTY; kill flips connected', async () => {
    platform.set('linux');
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
