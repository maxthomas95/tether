import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), resolve: vi.fn(), system: vi.fn(), warn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('../cli/executable-resolver', () => ({
  resolveCliExecutable: mocks.resolve, resolveWindowsSystemExecutable: mocks.system,
}));
vi.mock('../logger', () => ({ createLogger: () => ({ warn: mocks.warn }) }));

import { listOpencodeTranscripts, opencodeTranscriptExists } from './transcripts';

function child() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), pid: undefined as number | undefined,
  });
}

const cwd = path.resolve('sample-project');
const row = (id = 'ses_one', updated = 10) => ({ id, directory: cwd, title: 'A session', updated });
let proc: ReturnType<typeof child>;

function respond(value: unknown, code = 0) {
  proc.stdout.write(JSON.stringify(value));
  proc.emit('close', code);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  proc = child();
  mocks.spawn.mockReturnValue(proc);
  mocks.resolve.mockReturnValue({ kind: 'direct', file: '/tools/opencode', args: ['session', 'list', '--format', 'json'] });
  mocks.system.mockReturnValue(null);
});
afterEach(() => { vi.useRealTimers(); });

describe('OpenCode transcript discovery', () => {
  it('uses the shared resolver and keeps metadata commands outside the PTY', async () => {
    const pending = listOpencodeTranscripts(cwd);
    expect(mocks.resolve).toHaveBeenCalledWith('opencode', { args: ['session', 'list', '--format', 'json'] });
    expect(mocks.spawn).toHaveBeenCalledWith('/tools/opencode', ['session', 'list', '--format', 'json'], {
      shell: false, windowsHide: true, windowsVerbatimArguments: false, stdio: ['ignore', 'pipe', 'pipe'],
    });
    respond([row()]);
    expect(await pending).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes a Windows shim command verbatim to the resolved system shell', async () => {
    mocks.resolve.mockReturnValue({ kind: 'cmd', file: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/c', 'quoted command'] });
    const pending = listOpencodeTranscripts(cwd);
    expect(mocks.spawn).toHaveBeenCalledWith('C:\\Windows\\System32\\cmd.exe', ['/d', '/c', 'quoted command'],
      expect.objectContaining({ windowsVerbatimArguments: true, shell: false }));
    respond([]);
    await expect(pending).resolves.toEqual([]);
  });

  it('returns no history without spawning when OpenCode is unavailable', async () => {
    mocks.resolve.mockReturnValue(null);
    await expect(listOpencodeTranscripts(cwd)).resolves.toEqual([]);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('sorts matching sessions newest first and applies the result limit', async () => {
    const pending = listOpencodeTranscripts(cwd, 1);
    respond([row('old', 10), { ...row('elsewhere', 30), directory: path.resolve('other-project') }, row('new', 20)]);
    await expect(pending).resolves.toEqual([{
      id: 'new', mtime: '1970-01-01T00:00:00.020Z', preview: 'A session', cliTool: 'opencode', sourcePath: cwd,
    }]);
  });

  it('ignores malformed rows and tolerates unsupported optional metadata', async () => {
    const pending = listOpencodeTranscripts(cwd);
    respond([null, 3, {}, { ...row(), id: 4 }, { ...row(), directory: {} },
      { ...row(), directory: '\u0000bad' }, { ...row(), updated: 1e100, title: {} }]);
    const result = await pending;
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ mtime: '1970-01-01T00:00:00.000Z', preview: '' });
  });

  it('preserves Unicode split between stdout chunks', async () => {
    const pending = listOpencodeTranscripts(cwd);
    const bytes = Buffer.from(JSON.stringify([{ ...row(), title: '日本語 🌊' }]));
    const split = bytes.indexOf(Buffer.from('日')) + 1;
    proc.stdout.write(bytes.subarray(0, split));
    proc.stdout.write(bytes.subarray(split));
    proc.emit('close', 0);
    expect((await pending)[0].preview).toBe('日本語 🌊');
  });

  it.each([true, false])('checks the exact conversation and working directory (exists=%s)', async exists => {
    const pending = opencodeTranscriptExists(cwd, 'ses_target');
    respond([{ ...row('ses_target'), directory: exists ? cwd : path.resolve('elsewhere') }, row('ses_other')]);
    await expect(pending).resolves.toBe(exists);
  });

  it.each(['throw', 'error', 'exit', 'object', 'json'])('settles a %s failure and clears the timeout', async failure => {
    if (failure === 'throw') mocks.spawn.mockImplementationOnce(() => { throw new Error('spawn failed'); });
    const pending = listOpencodeTranscripts(cwd);
    if (failure === 'error') proc.emit('error', new Error('spawn failed'));
    if (failure === 'exit') respond([], 1);
    if (failure === 'object') respond({ sessions: [] });
    if (failure === 'json') { proc.stdout.write('private transcript content'); proc.emit('close', 0); }
    await expect(pending).resolves.toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain('private transcript content');
  });

  it('stops an oversized response and ignores a late close', async () => {
    const pending = listOpencodeTranscripts(cwd);
    proc.stdout.write(Buffer.alloc(4 * 1024 * 1024 + 1));
    await expect(pending).resolves.toEqual([]);
    expect(proc.kill).toHaveBeenCalledOnce();
    respond([row()]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out a stalled reader and ignores later data or errors', async () => {
    const pending = listOpencodeTranscripts(cwd);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(pending).resolves.toEqual([]);
    expect(proc.kill).toHaveBeenCalledOnce();
    proc.stdout.write('late output');
    proc.emit('error', new Error('late error'));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.skipIf(process.platform !== 'win32').each(['error', 'exit'])('stops the Windows shim process tree and handles cleanup %s', async failure => {
    proc.pid = 123;
    mocks.system.mockReturnValue('C:\\Windows\\System32\\taskkill.exe');
    const cleanup = child();
    mocks.spawn.mockReturnValueOnce(proc).mockReturnValueOnce(cleanup);
    const pending = listOpencodeTranscripts(cwd);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(pending).resolves.toEqual([]);
    expect(mocks.spawn).toHaveBeenLastCalledWith('C:\\Windows\\System32\\taskkill.exe', ['/pid', '123', '/t', '/f'],
      { shell: false, windowsHide: true, stdio: 'ignore' });
    if (failure === 'error') cleanup.emit('error', new Error('cleanup failed'));
    else cleanup.emit('exit', 1);
    expect(proc.kill).toHaveBeenCalledOnce();
  });
});
