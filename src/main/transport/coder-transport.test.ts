import { describe, it, expect, vi } from 'vitest';
import { createTransportOptions, getPtySpawnSpy, setupPtyTransportTest } from './transport-test-utils.test-helper';

import { CoderTransport } from './coder-transport';

const baseOptions = createTransportOptions('workspace1');
const ptySpawnSpy = getPtySpawnSpy();

describe('CoderTransport', () => {
  const { ptyHarness, platform } = setupPtyTransportTest();

  it('uses the default `coder` binary when none configured', async () => {
    platform.set('linux');
    await new CoderTransport().start(baseOptions());
    const [file] = ptySpawnSpy.mock.calls[0];
    expect(file).toBe('coder');
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
    const writes = ptyHarness.current!.write.mock.calls.map((c) => c[0]).join('');
    expect(writes).toContain("cd 'repos/tether'");
  });

  it('does not emit a cd step for bare workspace names', async () => {
    platform.set('linux');
    await new CoderTransport().start(baseOptions({ workingDir: 'ws-prod' }));
    const [, args] = ptySpawnSpy.mock.calls[0];
    expect(args).toEqual(['ssh', 'ws-prod']);
    const writes = ptyHarness.current!.write.mock.calls.map((c) => c[0]).join('');
    expect(writes).not.toContain('cd ');
  });

  it('on win32, wraps the binary in cmd.exe /c', async () => {
    platform.set('win32');
    await new CoderTransport().start(baseOptions({ workingDir: 'ws' }));
    const [file, args] = ptySpawnSpy.mock.calls[0];
    expect(file).toBe('cmd.exe');
    expect(args).toEqual(['/c', 'coder', 'ssh', 'ws']);
  });

  it('preserves a leading ~ in the subdir path (for remote shell expansion)', async () => {
    platform.set('linux');
    await new CoderTransport().start(baseOptions({ workingDir: 'ws::~/code/foo' }));
    const writes = ptyHarness.current!.write.mock.calls.map((c) => c[0]).join('');
    // ~ stays unquoted, the rest gets shell-quoted
    expect(writes).toContain("cd ~/'code/foo'");
  });

  it('shell-escapes env values with single quotes', async () => {
    platform.set('linux');
    await new CoderTransport().start(baseOptions({
      workingDir: 'ws',
      env: { TRICKY: "it's $weird" },
    }));
    const writes = ptyHarness.current!.write.mock.calls.map((c) => c[0]).join('');
    // The whole NAME=value pair is one argv word to env(1).
    expect(writes).toContain(`'TRICKY=it'\\''s $weird'`);
  });

  it('issues a guarded git clone when cloneUrl + subdir set, skipping if dir exists', async () => {
    platform.set('linux');
    await new CoderTransport().start(baseOptions({
      workingDir: 'ws::repos/proj',
      cloneUrl: 'https://github.com/example/proj.git',
    }));
    const writes = ptyHarness.current!.write.mock.calls.map((c) => c[0]).join('');
    expect(writes).toContain("[ -d 'repos/proj' ] || git clone 'https://github.com/example/proj.git' 'repos/proj'");
  });

  it('passes initialPrompt as a single shell-escaped positional arg', async () => {
    platform.set('linux');
    await new CoderTransport().start(baseOptions({
      workingDir: 'ws',
      initialPrompt: 'fix it pls',
    }));
    const writes = ptyHarness.current!.write.mock.calls.map((c) => c[0]).join('');
    expect(writes).toContain("claude 'fix it pls'");
  });

  it('fans onData / onExit and dispose clears callbacks', async () => {
    platform.set('linux');
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
