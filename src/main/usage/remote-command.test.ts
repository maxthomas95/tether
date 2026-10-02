import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProbeCommand, coderUsageConnection, connectRemoteUsage, parseProbeReply } from './remote-command';
import { getEnvironment } from '../db/environment-repo';
import { resolveSshConfig } from '../ssh/resolve-ssh-config';
import { connectSshControl } from '../cli-config/remote/ssh-control-connection';
import { remoteUsageKey, type RemoteUsageRequest } from './remote-protocol';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));
vi.mock('../db/environment-repo', () => ({ getEnvironment: vi.fn() }));
vi.mock('../ssh/resolve-ssh-config', () => ({ resolveSshConfig: vi.fn() }));
vi.mock('../cli-config/remote/ssh-control-connection', () => ({ connectSshControl: vi.fn() }));

const request: RemoteUsageRequest = { cli: 'codex', marker: 'pane', workingDir: '/work' };
function child() {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn() });
  spawnMock.mockReturnValueOnce(child);
  return child;
}
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('remote usage command boundary', () => {
  it('passes Coder workspace as an argument and never allocates a PTY or starts a stopped workspace', async () => {
    const process = child();
    const connection = coderUsageConnection('C:\\Tools\\coder.exe', 'owner/work space');
    const pending = connection.poll(request);
    expect(spawnMock).toHaveBeenCalledWith('C:\\Tools\\coder.exe', ['ssh', '--disable-autostart', 'owner/work space', '--', expect.any(String)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    process.stdout.write('login banner\n__TETHER_USAGE__{"status":"pending"}\n');
    process.emit('close', 0);
    await expect(pending).resolves.toEqual({ status: 'pending' });
    connection.close();
  });

  it('bounds hung commands and output without exposing remote stderr', async () => {
    vi.useFakeTimers();
    const process = child();
    const pending = coderUsageConnection('coder', 'work').poll(request);
    const checked = expect(pending).rejects.toThrow('timed out');
    process.stderr.write('a remote secret must not reach the error');
    await vi.advanceTimersByTimeAsync(30_000);
    await checked;
    expect(process.kill).toHaveBeenCalledOnce();

    const noisy = child();
    const oversized = coderUsageConnection('coder', 'work').poll(request);
    noisy.stdout.write(Buffer.alloc(4 * 1024 * 1024 + 1));
    await expect(oversized).rejects.toThrow('exceeded limit');
    expect(noisy.kill).toHaveBeenCalledOnce();
  });

  it('rejects invalid cursors and distinguishes same native id on separate hosts/workspaces/tools', () => {
    const source = { scope: 'user', nativeSessionId: 'same', path: '/rollout.jsonl', identity: 'id' };
    expect(() => parseProbeReply('__TETHER_USAGE__' + JSON.stringify({ status: 'ready', source, offset: -1, text: '' }))).toThrow('cursor');
    const keys = [remoteUsageKey('a', 'w', 'claude', source), remoteUsageKey('b', 'w', 'claude', source), remoteUsageKey('a', 'v', 'claude', source), remoteUsageKey('a', 'w', 'codex', source)];
    expect(new Set(keys).size).toBe(4);
  });

  it('encodes request paths as data and keeps sudo password input off the command line', () => {
    const command = buildProbeCommand({ ...request, workingDir: "~/path' $(touch injected) `whoami`" }, true, true);
    expect(command).toMatch(/^sudo -S -p '' -i -- sh -lc /);
    expect(command).not.toContain('touch injected');
    expect(command.length).toBeLessThan(30_000);
    expect(buildProbeCommand(request, true)).toMatch(/^sudo -n -i/);
  });

  it('runs the quoted probe through a real POSIX shell', async () => {
    const { execFileSync } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const shell = process.platform === 'win32' ? path.join(process.env.ProgramFiles || '', 'Git', 'bin', 'bash.exe') : '/bin/sh';
    if (!fs.existsSync(shell)) return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tether-usage-quote'-$-"));
    try {
      const file = path.join(dir, 'projects', fs.realpathSync(dir).replace(/[\\/:]/g, '-'), 'native.jsonl');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '{"type":"user","message":"private"}\n');
      const command = buildProbeCommand({ cli: 'claude', marker: 'pane', workingDir: dir, claudeHome: dir, nativeSessionId: 'native' });
      const stdout = execFileSync(shell, ['-s'], { input: command, windowsHide: true, timeout: 10_000, encoding: 'utf8' });
      expect(parseProbeReply(stdout).source?.nativeSessionId).toBe('native');
      expect(stdout).not.toContain('private');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('resident ssh usage probe', () => {
  /** A ControlConnection whose spawn hands the test the probe's stdin/stdout. */
  function host(sshConfig: Record<string, unknown> = { useSudo: true, password: 'pw' }) {
    const writes: string[] = [];
    let emit: (line: string) => void = () => {};
    let exit: () => void = () => {};
    const kill = vi.fn();
    const end = vi.fn();
    const spawn = vi.fn(async () => ({
      write: (data: string) => { writes.push(data); },
      onLine: (cb: (line: string) => void) => { emit = cb; },
      onExit: (cb: () => void) => { exit = cb; },
      kill,
    }));
    vi.mocked(getEnvironment).mockReturnValue({ type: 'ssh', config: '{}' } as never);
    vi.mocked(resolveSshConfig).mockResolvedValue(sshConfig as never);
    vi.mocked(connectSshControl).mockResolvedValue({ spawn, end } as never);
    const reply = (id: number, body: Record<string, unknown>) =>
      emit('__TETHER_USAGE__' + JSON.stringify({ id, ...body }));
    return { writes, spawn, kill, end, reply, fail: () => exit() };
  }
  const source = { scope: 'user', nativeSessionId: 'n', path: '/p.jsonl', identity: 'i' };

  it('authenticates once per connection and multiplexes every poll over one process', async () => {
    const h = host();
    const connection = await connectRemoteUsage('env', 'workspace');

    expect(h.spawn).toHaveBeenCalledOnce();
    const command = h.spawn.mock.calls[0][0] as unknown as string;
    expect(command).toMatch(/^sudo -S -p '' -i -- sh -lc /);
    // Resident form: the bundled program with no request argument after it, so
    // the probe reads requests from stdin instead of being respawned per poll.
    expect(command).toBe(buildProbeCommand(undefined, true, true));
    expect(command).not.toContain(Buffer.from(JSON.stringify(request)).toString('base64'));
    expect(command.length).toBeLessThan(buildProbeCommand(request, true, true).length);
    expect(h.writes).toEqual(['pw\n']);

    const first = connection.poll(request);
    const second = connection.poll(request);
    expect(h.spawn).toHaveBeenCalledOnce();
    expect(h.writes).toHaveLength(3);
    const ids = h.writes.slice(1).map(w => JSON.parse(Buffer.from(w.trim(), 'base64').toString('utf8')).id);
    expect(new Set(ids).size).toBe(2);

    // Replies are routed by id, so an out-of-order answer reaches its own caller.
    h.reply(ids[1], { status: 'ready', source, offset: 5, text: '', reset: false });
    h.reply(ids[0], { status: 'pending' });
    await expect(first).resolves.toEqual({ status: 'pending', id: ids[0] });
    await expect(second).resolves.toMatchObject({ status: 'ready', offset: 5 });

    connection.close();
    expect(h.kill).toHaveBeenCalledOnce();
    expect(h.end).toHaveBeenCalledOnce();
  });

  it('writes no password when the host needs no sudo', async () => {
    const h = host({ useSudo: false });
    await connectRemoteUsage('env', 'workspace');
    expect(h.spawn.mock.calls[0][0]).toMatch(/^sh -lc /);
    expect(h.writes).toEqual([]);
  });

  it('fails in-flight polls when the probe dies, and refuses to poll after', async () => {
    const h = host();
    const connection = await connectRemoteUsage('env', 'workspace');
    const pending = connection.poll(request);
    h.fail();
    await expect(pending).rejects.toThrow('Remote usage reader unavailable');
    await expect(connection.poll(request)).rejects.toThrow('Remote usage reader unavailable');
  });

  it('bounds a poll the probe never answers', async () => {
    vi.useFakeTimers();
    const h = host();
    const connection = await connectRemoteUsage('env', 'workspace');
    const pending = connection.poll(request);
    const checked = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(30_000);
    await checked;
    // A late reply for a timed-out request is discarded, not mis-delivered.
    expect(() => h.reply(0, { status: 'pending' })).not.toThrow();
  });

  it('rejects the matching caller when the probe returns an invalid reply', async () => {
    const h = host();
    const connection = await connectRemoteUsage('env', 'workspace');
    const pending = connection.poll(request);
    const id = JSON.parse(Buffer.from(h.writes[1].trim(), 'base64').toString('utf8')).id;
    h.reply(id, { status: 'ready', source, offset: -1, text: '' });
    await expect(pending).rejects.toThrow('cursor');
  });
});
