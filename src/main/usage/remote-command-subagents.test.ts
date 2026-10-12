import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProbeCommand, connectRemoteUsage } from './remote-command';
import { getEnvironment } from '../db/environment-repo';
import { resolveSshConfig } from '../ssh/resolve-ssh-config';
import { connectSshControl } from '../cli-config/remote/ssh-control-connection';
import type { RemoteSubagentRequest } from './remote-protocol';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));
vi.mock('../db/environment-repo', () => ({ getEnvironment: vi.fn() }));
vi.mock('../ssh/resolve-ssh-config', () => ({ resolveSshConfig: vi.fn() }));
vi.mock('../cli-config/remote/ssh-control-connection', () => ({ connectSshControl: vi.fn() }));

const MARK = '__TETHER_USAGE__';
const request: RemoteSubagentRequest = { op: 'subagents', cli: 'claude', sessionId: '11111111-2222-4333-8444-555555555555', workingDir: '/work' };
const listing = { op: 'subagents', status: 'ready', found: true, project: 'p', agents: [], total: 0, more: false, now: 1 };
const decode = (line: string) => JSON.parse(Buffer.from(line.trim(), 'base64').toString('utf8')) as { id: number; op?: string };

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('subagent requests over the resident reader', () => {
  /** An SSH control connection whose spawned reader the test drives. */
  function sshHost(config: Record<string, unknown>) {
    const writes: string[] = [];
    let emit: (line: string) => void = () => {};
    let exit: () => void = () => {};
    const spawn = vi.fn(async () => ({
      write: (data: string) => { writes.push(data); },
      onLine: (cb: (line: string) => void) => { emit = cb; },
      onExit: (cb: () => void) => { exit = cb; },
      kill: vi.fn(),
    }));
    vi.mocked(getEnvironment).mockReturnValue({ type: 'ssh', config: '{}' } as never);
    vi.mocked(resolveSshConfig).mockResolvedValue(config as never);
    vi.mocked(connectSshControl).mockResolvedValue({ spawn, end: vi.fn() } as never);
    return { writes, spawn, emit: (body: object) => emit(MARK + JSON.stringify(body)), exit: () => exit() };
  }

  it('sends every poll down the one process an elevated host authenticated once', async () => {
    const host = sshHost({ useSudo: true, password: 'pw' });
    const connection = await connectRemoteUsage('env', '', undefined, { resident: true });
    const answered: Promise<unknown>[] = [];
    for (let i = 0; i < 40; i++) {
      answered.push(connection.poll(request));
      host.emit({ id: i, ...listing });
    }
    await expect(Promise.all(answered)).resolves.toHaveLength(40);
    // One spawn (one `sudo -i`), one password line, forty requests, nothing else.
    expect(host.spawn).toHaveBeenCalledOnce();
    expect(host.spawn.mock.calls[0]).toEqual([buildProbeCommand(undefined, true, true), expect.objectContaining({ maxLineBytes: expect.any(Number) })]);
    expect(host.writes).toHaveLength(41);
    expect(host.writes[0]).toBe('pw\n');
    expect(host.writes.slice(1).map(w => decode(w).op)).toEqual(Array(40).fill('subagents'));
    expect(vi.mocked(connectSshControl)).toHaveBeenCalledOnce();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('validates subagent replies and routes them by id alongside usage replies', async () => {
    const host = sshHost({ useSudo: false });
    const connection = await connectRemoteUsage('env', '');
    const sub = connection.poll(request);
    const usage = connection.poll({ cli: 'claude', marker: 'm', workingDir: '/work' });
    host.emit({ id: 1, status: 'pending' });
    host.emit({ id: 0, ...listing });
    await expect(usage).resolves.toEqual({ status: 'pending', id: 1 });
    await expect(sub).resolves.toMatchObject({ op: 'subagents', found: true });

    const bad = connection.poll(request);
    host.emit({ id: 2, ...listing, agents: [{ id: '../x' }] });
    await expect(bad).rejects.toThrow('Invalid remote subagent reply');
    // A rejected reply fails that request only; the reader is still alive.
    const next = connection.poll(request);
    host.emit({ id: 3, ...listing });
    await expect(next).resolves.toBeDefined();
    expect(connection.isDead?.()).toBe(false);
  });

  function coderChild() {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(),
    });
    spawnMock.mockReturnValueOnce(child);
    const written: string[] = [];
    child.stdin.on('data', (d: Buffer) => written.push(d.toString()));
    return { child, written };
  }

  it('runs Coder as one long-lived command and never spawns again per poll', async () => {
    vi.mocked(getEnvironment).mockReturnValue({ type: 'coder', config: JSON.stringify({ binaryPath: 'coder-bin' }) } as never);
    const { child, written } = coderChild();
    const connection = await connectRemoteUsage('env', 'owner/ws', undefined, { resident: true });
    expect(spawnMock).toHaveBeenCalledOnce();
    expect(spawnMock).toHaveBeenCalledWith('coder-bin', ['ssh', '--disable-autostart', 'owner/ws', '--', buildProbeCommand()], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

    for (let i = 0; i < 12; i++) {
      const pending = connection.poll(request);
      await new Promise(resolve => setImmediate(resolve));
      expect(decode(written.join('').trim().split('\n').at(-1)!).id).toBe(i);
      child.stdout.write('motd noise\n' + MARK + JSON.stringify({ id: i, ...listing }) + '\n');
      await expect(pending).resolves.toMatchObject({ op: 'subagents' });
    }
    expect(spawnMock).toHaveBeenCalledOnce();
    expect(written.join('').trim().split('\n')).toHaveLength(12);

    connection.close();
    expect(child.kill).toHaveBeenCalledOnce();
    await expect(connection.poll(request)).rejects.toThrow('unavailable');
  });

  it('fails in-flight Coder polls when the command exits, and marks the reader dead', async () => {
    vi.mocked(getEnvironment).mockReturnValue({ type: 'coder', config: '{}' } as never);
    const { child } = coderChild();
    const connection = await connectRemoteUsage('env', 'ws', undefined, { resident: true });
    const pending = connection.poll(request);
    const failed = expect(pending).rejects.toThrow('unavailable');
    child.emit('close', 1);
    await failed;
    expect(connection.isDead?.()).toBe(true);
    expect(spawnMock).toHaveBeenCalledOnce();
  });

  it('leaves usage polling for Coder exactly as it was unless a resident reader is requested', async () => {
    vi.mocked(getEnvironment).mockReturnValue({ type: 'coder', config: '{}' } as never);
    const child = coderChild().child;
    const connection = await connectRemoteUsage('env', 'ws');
    expect(spawnMock).not.toHaveBeenCalled();
    const pending = connection.poll({ cli: 'claude', marker: 'm', workingDir: '.' });
    expect(spawnMock).toHaveBeenCalledOnce();
    child.stdout.write(MARK + '{"status":"pending"}\n');
    child.emit('close', 0);
    await expect(pending).resolves.toEqual({ status: 'pending' });
  });

  it('bounds one reply line and drops the reader instead of buffering without end', async () => {
    vi.mocked(getEnvironment).mockReturnValue({ type: 'coder', config: '{}' } as never);
    const { child } = coderChild();
    const connection = await connectRemoteUsage('env', 'ws', undefined, { resident: true });
    const pending = connection.poll(request);
    const failed = expect(pending).rejects.toThrow('unavailable');
    child.stdout.write(Buffer.alloc(16 * 1024 * 1024 + 1, 0x61));
    await failed;
    expect(child.kill).toHaveBeenCalled();
  });
});
