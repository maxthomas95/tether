import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const run = vi.hoisted(() => vi.fn());
vi.mock('../cli/metadata-command', () => ({ runCliMetadata: run }));
import { NativeOpenCodeUsageSource, openCodeUsageContext } from './native-usage-source';

const cwd = path.resolve('project');
const data = path.resolve(cwd, 'data', 'opencode');
const context = { cwd, env: { XDG_DATA_HOME: 'data', OPENCODE_DB: undefined, OPENCODE_DISABLE_CHANNEL_DB: undefined } };
beforeEach(() => { vi.useFakeTimers(); run.mockReset(); run.mockResolvedValue({ ok: true, stdout: '1.14.44\n' }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('native OpenCode database discovery', () => {
  it('resolves native relative overrides without starting a database command or retaining credentials', async () => {
    const source = new NativeOpenCodeUsageSource();
    const filtered = openCodeUsageContext(cwd, { ...context.env, OPENCODE_DB: 'custom.db', ANTHROPIC_API_KEY: 'private', Path: '/tools' });
    expect(filtered.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    await expect(source.resolvePath(filtered)).resolves.toBe(path.join(data, 'custom.db'));
    expect(run).not.toHaveBeenCalled();
  });

  it('resolves absolute overrides without probing or creating a database', async () => {
    const absolute = path.resolve('alternate/native.db');
    await expect(new NativeOpenCodeUsageSource().resolvePath({ ...context, env: { ...context.env, OPENCODE_DB: absolute } })).resolves.toBe(absolute);
    expect(run).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== 'win32')('resolves drive-rooted overrides on the launch drive', async () => {
    await expect(new NativeOpenCodeUsageSource().resolvePath({ cwd: 'D:\\project', env: { OPENCODE_DB: '\\data\\opencode.db' } }))
      .resolves.toBe('D:\\data\\opencode.db');
    expect(run).not.toHaveBeenCalled();
  });

  it('uses only an eager version probe for official stable layout discovery', async () => {
    await expect(new NativeOpenCodeUsageSource().resolvePath(context)).resolves.toBe(path.join(data, 'opencode.db'));
    expect(run).toHaveBeenCalledWith('opencode', ['--version'], { timeoutMs: 5000, maxBytes: 4096, ...context });
  });

  it.each([['0.0.0-beta-202610151200', 'opencode.db'], ['0.0.0-canary-202610151200', 'opencode-canary.db']])('resolves official preview %s', async (version, file) => {
    run.mockResolvedValue({ ok: true, stdout: version });
    await expect(new NativeOpenCodeUsageSource().resolvePath(context)).resolves.toBe(path.join(data, file));
  });

  it.each(['true', 'TRUE', '1'])('honors channel database disabling (%s) without a probe', async value => {
    await expect(new NativeOpenCodeUsageSource().resolvePath({ ...context, env: { ...context.env, OPENCODE_DISABLE_CHANNEL_DB: value } })).resolves.toBe(path.join(data, 'opencode.db'));
    expect(run).not.toHaveBeenCalled();
  });

  it.each(['', 'local', 'private custom build', '1.14.44\nother', 'bad\0version'])('rejects an unknown build %j and retries with backoff', async stdout => {
    const source = new NativeOpenCodeUsageSource(); run.mockResolvedValue({ ok: true, stdout });
    await expect(source.resolvePath(context)).resolves.toBeNull();
    await source.resolvePath(context); expect(run).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_001);
    await source.resolvePath(context); expect(run).toHaveBeenCalledTimes(2);
  });

  it.each([':memory:', 'bad\0.db'])('rejects unusable database override %j', async OPENCODE_DB => {
    await expect(new NativeOpenCodeUsageSource().resolvePath({ ...context, env: { ...context.env, OPENCODE_DB } })).resolves.toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it('coalesces concurrent discovery, caches successes and separates executable overrides', async () => {
    const source = new NativeOpenCodeUsageSource();
    await Promise.all([source.resolvePath(context), source.resolvePath(context)]);
    await source.resolvePath(context); expect(run).toHaveBeenCalledOnce();
    await source.resolvePath({ ...context, env: { ...context.env, OPENCODE_BIN_PATH: '/alternate/opencode' } });
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(300_001); await source.resolvePath(context);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it.each(['win32', 'linux'])('uses the effective native home on %s when XDG is absent', async platform => {
    vi.stubGlobal('process', { ...process, platform });
    const home = path.resolve('home');
    const env = { XDG_DATA_HOME: undefined, OPENCODE_DB: 'custom.db', USERPROFILE: home, HOME: home };
    await expect(new NativeOpenCodeUsageSource().resolvePath({ cwd, env })).resolves.toBe(path.join(home, '.local', 'share', 'opencode', 'custom.db'));
  });

  it('supports the application default context', async () => {
    await expect(new NativeOpenCodeUsageSource().resolvePath()).resolves.toEqual(expect.any(String));
    expect(run.mock.calls[0][2].cwd).toBe(os.homedir());
  });

  it('treats a missing executable as unavailable without accessing a database', async () => {
    run.mockResolvedValue({ ok: false, reason: 'unavailable' });
    await expect(new NativeOpenCodeUsageSource().resolvePath(context)).resolves.toBeNull();
  });
});
