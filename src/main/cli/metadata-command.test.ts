import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), resolve: vi.fn(), system: vi.fn(), stat: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('node:fs', () => ({ statSync: mocks.stat }));
vi.mock('./executable-resolver', () => ({
  resolveCliExecutable: mocks.resolve, resolveWindowsSystemExecutable: mocks.system,
}));

import { runCliMetadata } from './metadata-command';

function child() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), pid: undefined as number | undefined,
  });
}

let proc: ReturnType<typeof child>;
const args = ['session', 'list', '--format', 'json'] as const;
const tools = ['claude', 'codex', 'opencode'] as const;
const taskkill = 'C:\\Windows\\System32\\taskkill.exe';

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  proc = child();
  mocks.spawn.mockReset().mockReturnValue(proc);
  mocks.resolve.mockReset().mockImplementation(tool => ({ kind: 'direct', file: `/tools/${tool}`, args: [...args] }));
  mocks.system.mockReset().mockReturnValue(null);
  mocks.stat.mockReset().mockReturnValue({ isDirectory: () => true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('CLI metadata commands', () => {
  it.each(tools)('launches %s through the shared resolver without stdin, a PTY, or shell expansion', async tool => {
    const pending = runCliMetadata(tool, args);
    expect(mocks.resolve).toHaveBeenCalledWith(tool, expect.objectContaining({ args }));
    expect(mocks.spawn).toHaveBeenCalledWith(`/tools/${tool}`, args, {
      shell: false, windowsHide: true, windowsVerbatimArguments: false, stdio: ['ignore', 'pipe', 'pipe'],
      env: expect.objectContaining(process.env),
    });
    proc.stdout.write('metadata');
    proc.emit('close', 0);
    await expect(pending).resolves.toEqual({ ok: true, stdout: 'metadata' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(tools)('passes the resolved %s Windows npm shim command verbatim to the system shell', async tool => {
    const file = 'C:\\Windows\\System32\\cmd.exe';
    const shimArgs = ['/d', '/v:off', '/s', '/c', 'quoted shim command'];
    mocks.resolve.mockReturnValue({ kind: 'cmd', file, args: shimArgs });
    const pending = runCliMetadata(tool, args);
    expect(mocks.spawn).toHaveBeenCalledWith(file, shimArgs,
      expect.objectContaining({ windowsVerbatimArguments: true, shell: false }));
    proc.emit('close', 0);
    await expect(pending).resolves.toEqual({ ok: true, stdout: '' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the effective Windows PATH/env/cwd and replaces inherited environment keys case-insensitively', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32', env: {
      PATH: 'C:\\old', PATHEXT: '.EXE', ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\inherited-home', KEEP_ME: 'inherited',
    } });
    const overrides = { Path: 'C:\\effective tools', PathExt: '.CMD', USERPROFILE: 'D:\\session-home', OPENCODE_DB: 'D:\\private.db' };
    const pending = runCliMetadata('opencode', args, { env: overrides, cwd: 'D:\\project' });
    expect(mocks.resolve).toHaveBeenCalledWith('opencode', {
      args, pathEnv: overrides.Path, pathExt: '.CMD', comSpec: 'C:\\Windows\\System32\\cmd.exe', systemRoot: 'C:\\Windows',
    });
    expect(mocks.spawn).toHaveBeenCalledWith('/tools/opencode', args, expect.objectContaining({
      cwd: 'D:\\project', env: {
        ...overrides, ComSpec: 'C:\\Windows\\System32\\cmd.exe', SystemRoot: 'C:\\Windows', KEEP_ME: 'inherited',
      },
    }));
    expect(process.env.PATH).toBe('C:\\old');
    proc.emit('close', 0);
    await expect(pending).resolves.toEqual({ ok: true, stdout: '' });
  });

  it('keeps POSIX environment keys case-sensitive and preserves inherited values', async () => {
    vi.stubGlobal('process', { ...process, platform: 'linux', env: { PATH: '/usr/bin', HOME: '/inherited' } });
    const pending = runCliMetadata('claude', args, { env: { PATH: '/opt/session', Path: 'unrelated', HOME: '/session' } });
    expect(mocks.resolve).toHaveBeenCalledWith('claude', expect.objectContaining({ pathEnv: '/opt/session' }));
    expect(mocks.spawn).toHaveBeenCalledWith('/tools/claude', args, expect.objectContaining({
      env: { PATH: '/opt/session', Path: 'unrelated', HOME: '/session' },
    }));
    proc.emit('close', 0);
    await pending;
  });

  it('does not fall back to the app PATH when an override removes PATH', async () => {
    const pending = runCliMetadata('codex', args, { env: { PATH: undefined } });
    expect(mocks.resolve).toHaveBeenCalledWith('codex', expect.objectContaining({ pathEnv: '' }));
    proc.emit('close', 0);
    await pending;
  });

  it.each([
    ['win32', 'D:\\Other Projects\\one\\..\\selected'],
    ['win32', '\\\\server\\share\\Other Projects\\selected'],
    ['win32', `\\\\?\\D:\\${'long directory\\'.repeat(30)}selected`],
    ['win32', '\\\\?\\UNC\\server\\share\\selected'],
    ['linux', '/home/someone/Other Projects/one/../selected'],
  ] as const)('validates and normalizes a selected %s project directory outside the app root (%s)', async (platform, cwd) => {
    vi.stubGlobal('process', { ...process, platform });
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const expected = paths.resolve(cwd);
    const pending = runCliMetadata('opencode', args, { cwd });
    expect(mocks.stat).toHaveBeenCalledExactlyOnceWith(expected);
    expect(mocks.spawn).toHaveBeenCalledWith('/tools/opencode', args, expect.objectContaining({ cwd: expected }));
    proc.emit('close', 0);
    await expect(pending).resolves.toEqual({ ok: true, stdout: '' });
  });

  it.each([
    ['win32', ''], ['win32', '..\\outside'], ['win32', 'C:relative'],
    ['win32', '\\root-relative'], ['win32', '/root-relative'], ['win32', '\\\\server'],
    ['win32', 'D:\\project\0bad'], ['win32', 'D:\\project\nother'],
    ['linux', '../outside'], ['linux', 'project'], ['linux', '/project\0bad'], ['linux', '/project\rother'],
  ] as const)('rejects an invalid %s working directory before resolving or spawning (%s)', async (platform, cwd) => {
    vi.stubGlobal('process', { ...process, platform });
    await expect(runCliMetadata('opencode', args, { cwd })).resolves.toEqual({ ok: false, reason: 'failed' });
    expect(mocks.stat).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['missing', 'file'])('rejects a %s working directory without spawning or exposing filesystem errors', async failure => {
    if (failure === 'missing') mocks.stat.mockImplementationOnce(() => { throw new Error('private path details'); });
    else mocks.stat.mockReturnValueOnce({ isDirectory: () => false });
    await expect(runCliMetadata('opencode', args, { cwd: process.cwd() })).resolves.toEqual({ ok: false, reason: 'failed' });
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves the inherited working directory when no cwd is supplied', async () => {
    const pending = runCliMetadata('opencode', args);
    expect(mocks.stat).not.toHaveBeenCalled();
    expect(mocks.spawn.mock.calls[0][2]).not.toHaveProperty('cwd');
    proc.emit('close', 0);
    await pending;
  });

  it('returns unavailable without spawning or creating a timeout', async () => {
    mocks.resolve.mockReturnValue(null);
    await expect(runCliMetadata('opencode', args)).resolves.toEqual({ ok: false, reason: 'unavailable' });
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['resolve', 'spawn'])('returns failed when %s throws, without exposing the error text', async source => {
    const error = new Error('private conversation excerpt');
    if (source === 'resolve') mocks.resolve.mockImplementationOnce(() => { throw error; });
    else mocks.spawn.mockImplementationOnce(() => { throw error; });
    await expect(runCliMetadata('opencode', args)).resolves.toEqual({ ok: false, reason: 'failed' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([1, null])('returns failed for a nonzero or signal close (%s)', async code => {
    const pending = runCliMetadata('codex', args);
    proc.stdout.write('private output');
    proc.emit('close', code);
    await expect(pending).resolves.toEqual({ ok: false, reason: 'failed' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['process', 'stdout', 'stderr'])('handles %s errors and ignores subsequent process/stream events', async source => {
    const pending = runCliMetadata('claude', args);
    const emitter = source === 'process' ? proc : proc[source as 'stdout' | 'stderr'];
    emitter.emit('error', new Error('private output'));
    await expect(pending).resolves.toEqual({ ok: false, reason: 'failed' });
    expect(proc.kill).toHaveBeenCalledOnce();
    proc.stdout.write('late output');
    proc.emit('close', 0);
    proc.emit('error', new Error('late error'));
    expect(proc.kill).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves UTF-8 split between stdout chunks', async () => {
    const pending = runCliMetadata('opencode', args);
    const text = '日本語 🌊';
    const bytes = Buffer.from(text);
    for (const byte of bytes) proc.stdout.write(Buffer.from([byte]));
    proc.emit('close', 0);
    await expect(pending).resolves.toEqual({ ok: true, stdout: text });
  });

  it('drains stderr without returning or counting it against stdout', async () => {
    const resume = vi.spyOn(proc.stderr, 'resume');
    const pending = runCliMetadata('opencode', args, { maxBytes: 4 });
    expect(resume).toHaveBeenCalledOnce();
    proc.stderr.write('private stderr banner'.repeat(100));
    proc.stdout.write('safe');
    proc.emit('close', 0);
    await expect(pending).resolves.toEqual({ ok: true, stdout: 'safe' });
  });

  it('allows exactly the stdout byte limit, including multibyte characters', async () => {
    const pending = runCliMetadata('codex', args, { maxBytes: 3 });
    proc.stdout.write('日');
    proc.emit('close', 0);
    await expect(pending).resolves.toEqual({ ok: true, stdout: '日' });
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it.each(['single', 'accumulated'])('stops %s stdout above a custom limit and ignores late close/data/errors', async mode => {
    const pending = runCliMetadata('opencode', args, { maxBytes: 3 });
    if (mode === 'single') proc.stdout.write('1234');
    else { proc.stdout.write('12'); proc.stdout.write('34'); }
    await expect(pending).resolves.toEqual({ ok: false, reason: 'too-large' });
    expect(proc.kill).toHaveBeenCalledOnce();
    proc.stdout.write('late data');
    proc.emit('close', 0);
    proc.emit('error', new Error('late error'));
    expect(proc.kill).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('applies the default 4 MiB stdout limit', async () => {
    const pending = runCliMetadata('opencode', args);
    proc.stdout.write(Buffer.alloc(4 * 1024 * 1024 + 1));
    await expect(pending).resolves.toEqual({ ok: false, reason: 'too-large' });
    expect(proc.kill).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([undefined, 20])('times out at the configured deadline (%s)', async timeoutMs => {
    const pending = runCliMetadata('claude', args, { timeoutMs });
    const deadline = timeoutMs ?? 5000;
    await vi.advanceTimersByTimeAsync(deadline - 1);
    expect(proc.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ ok: false, reason: 'timeout' });
    expect(proc.kill).toHaveBeenCalledOnce();
    proc.emit('error', new Error('late error'));
    proc.emit('close', 0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a successful result stable after late events and its original deadline', async () => {
    const pending = runCliMetadata('claude', args);
    proc.stdout.write('metadata');
    proc.emit('close', 0);
    proc.stdout.write('late data');
    proc.emit('error', new Error('late error'));
    proc.stdout.emit('error', new Error('late stream error'));
    await vi.advanceTimersByTimeAsync(5000);
    await expect(pending).resolves.toEqual({ ok: true, stdout: 'metadata' });
    expect(proc.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['timeout', 'too-large'])('kills the Windows process tree on %s', async reason => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    proc.pid = 123;
    const cleanup = child();
    mocks.system.mockReturnValue(taskkill);
    mocks.spawn.mockReturnValueOnce(proc).mockReturnValueOnce(cleanup);
    const pending = runCliMetadata('opencode', args, { maxBytes: 1 });
    if (reason === 'timeout') await vi.advanceTimersByTimeAsync(5000);
    else proc.stdout.write('12');
    await expect(pending).resolves.toEqual({ ok: false, reason });
    expect(mocks.system).toHaveBeenCalledWith('taskkill.exe');
    expect(mocks.spawn).toHaveBeenLastCalledWith(taskkill, ['/pid', '123', '/t', '/f'],
      { shell: false, windowsHide: true, stdio: 'ignore' });
    cleanup.emit('exit', 0);
    expect(proc.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['missing', 'resolve', 'spawn', 'error', 'exit', 'signal'])('falls back to the direct Windows child when tree cleanup fails (%s)', async failure => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    proc.pid = 123;
    const cleanup = child();
    mocks.system.mockReturnValue(failure === 'missing' ? null : taskkill);
    if (failure === 'resolve') mocks.system.mockImplementationOnce(() => { throw new Error('unavailable'); });
    mocks.spawn.mockReturnValueOnce(proc).mockImplementationOnce(() => {
      if (failure === 'spawn') throw new Error('cleanup failed');
      return cleanup;
    });
    const pending = runCliMetadata('opencode', args);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(pending).resolves.toEqual({ ok: false, reason: 'timeout' });
    if (failure === 'error') {
      cleanup.emit('error', new Error('cleanup failed'));
      cleanup.emit('exit', 1);
      cleanup.emit('error', new Error('late cleanup error'));
    }
    if (failure === 'exit') cleanup.emit('exit', 1);
    if (failure === 'signal') cleanup.emit('exit', null);
    expect(proc.kill).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores direct kill errors after settling a timeout', async () => {
    proc.kill.mockImplementationOnce(() => { throw new Error('already gone'); });
    const pending = runCliMetadata('opencode', args);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(pending).resolves.toEqual({ ok: false, reason: 'timeout' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('kills only the direct child outside Windows', async () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' });
    proc.pid = 123;
    const pending = runCliMetadata('opencode', args);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(pending).resolves.toEqual({ ok: false, reason: 'timeout' });
    expect(proc.kill).toHaveBeenCalledOnce();
    expect(mocks.system).not.toHaveBeenCalled();
    expect(mocks.spawn).toHaveBeenCalledOnce();
  });
});
