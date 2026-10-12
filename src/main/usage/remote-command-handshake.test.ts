import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { READY_TIMEOUT_MS, connectRemoteUsage } from './remote-command';
import { RemoteAuthError, isRemoteAuthFailed, resetRemoteAuthState } from './remote-auth-state';
import { getEnvironment } from '../db/environment-repo';
import { resolveSshConfig } from '../ssh/resolve-ssh-config';
import { connectSshControl } from '../cli-config/remote/ssh-control-connection';
import type { RemoteSubagentRequest } from './remote-protocol';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));
vi.mock('../db/environment-repo', () => ({ getEnvironment: vi.fn() }));
vi.mock('../ssh/resolve-ssh-config', () => ({ resolveSshConfig: vi.fn() }));
vi.mock('../cli-config/remote/ssh-control-connection', () => ({ connectSshControl: vi.fn() }));
vi.mock('../logger', () => ({ createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn() }) }));

const MARK = '__TETHER_USAGE__';
/** Output from a remote process arrives after the caller has attached its listeners, never before. */
const defer = (fn: () => void) => { setImmediate(fn); };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const request: RemoteSubagentRequest = { op: 'subagents', cli: 'claude', sessionId: '11111111-2222-4333-8444-555555555555', workingDir: '/work' };

/**
 * What `sudo -S -p '' -i -- sh -lc …` does with stdin. Every line is a password
 * try until one is accepted; a refused try is answered on stderr ("Sorry, try
 * again.") and sudo goes on reading the next line as the next try, and only the
 * third refusal ends it. After an accepted password the line belongs to the
 * program, which announces itself with the caller's ready token.
 */
class FakeSudo {
  readonly stdin: string[] = [];
  readonly requests: string[] = [];
  attempts = 0;
  started = false;
  killed = false;
  private lineCbs: Array<(line: string) => void> = [];
  private exitCbs: Array<() => void> = [];
  private authCbs: Array<() => void> = [];
  readonly token: string;

  constructor(command: string, private readonly password: string | null, private readonly speaksEnglish = true) {
    this.token = /TETHER_PROBE_READY=([0-9a-f]+)/.exec(command)?.[1] ?? '';
    // `sudo -n` (no password supplied) with a password policy refuses at once.
    if (password === null && /^sudo -n /.test(command)) defer(() => this.refuse(true));
    // No sudo at all: the program starts immediately.
    else if (!/^sudo /.test(command)) defer(() => this.start());
  }

  process() {
    return {
      write: (data: string) => {
        for (const line of data.split('\n').filter(Boolean)) {
          this.stdin.push(line);
          if (this.killed) continue;
          if (this.started) this.requests.push(line);
          else defer(() => this.tryPassword(line));
        }
      },
      onLine: (cb: (line: string) => void) => { this.lineCbs.push(cb); },
      onExit: (cb: () => void) => { this.exitCbs.push(cb); },
      onAuthFailure: (cb: () => void) => { this.authCbs.push(cb); },
      kill: () => { this.killed = true; this.exitCbs.forEach(cb => cb()); },
    };
  }

  emit(line: string) { this.lineCbs.forEach(cb => cb(line)); }
  start(token = this.token) { this.started = true; this.emit(MARK + JSON.stringify({ ready: token })); }

  private tryPassword(line: string) {
    this.attempts++;
    if (line === this.password) { this.start(); return; }
    this.refuse(this.attempts >= 3);
  }

  private refuse(fatal: boolean) {
    if (this.speaksEnglish) this.authCbs.forEach(cb => cb());
    if (fatal) this.exitCbs.forEach(cb => cb());
  }
}

function sshHost(sudo: { useSudo: boolean; password?: string }, typed: string | null, speaksEnglish = true) {
  const fake: { current?: FakeSudo } = {};
  const end = vi.fn();
  const spawn = vi.fn(async (command: string) => {
    fake.current = new FakeSudo(command, typed, speaksEnglish);
    return fake.current.process();
  });
  vi.mocked(getEnvironment).mockReturnValue({ type: 'ssh', config: '{}' } as never);
  vi.mocked(resolveSshConfig).mockResolvedValue(sudo as never);
  vi.mocked(connectSshControl).mockResolvedValue({ spawn, end } as never);
  return { fake, spawn, end };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); resetRemoteAuthState(); });
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('resident reader handshake with sudo -S', () => {
  it('writes the password once and nothing else until the reader says it is ready', async () => {
    const h = sshHost({ useSudo: true, password: 'good' }, 'good');
    const connecting = connectRemoteUsage('env', '');
    const connection = await connecting;
    const pending = h.fake.current!;
    expect(pending.started).toBe(true);
    expect(pending.stdin).toEqual(['good']);

    const answered = connection.poll(request);
    await tick();
    expect(pending.requests).toHaveLength(1);
    expect(pending.attempts).toBe(1);
    pending.emit(MARK + JSON.stringify({ id: 0, op: 'subagents', status: 'ready', found: false, agents: [], total: 0, more: false, now: 1 }));
    await expect(answered).resolves.toMatchObject({ found: false });
  });

  it('does not send a request while the reader is silent, and ignores a ready line with the wrong token', async () => {
    const h = sshHost({ useSudo: true, password: 'good' }, 'good');
    // The reader exists but has not announced itself: slow login shell, say.
    h.spawn.mockImplementationOnce(async (command: string) => {
      const fake = new FakeSudo(command, 'good');
      Object.defineProperty(fake, 'start', { value: () => {} });
      h.fake.current = fake;
      return fake.process();
    });
    let settled = false;
    const connecting = connectRemoteUsage('env', '').then(c => { settled = true; return c; });
    await vi.advanceTimersByTimeAsync(5_000);
    const fake = h.fake.current!;
    fake.emit(MARK + JSON.stringify({ ready: 'not-the-token' }));
    fake.emit('some login banner');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(false);
    expect(fake.stdin).toEqual(['good']);
    fake.emit(MARK + JSON.stringify({ ready: fake.token }));
    const connection = await connecting;
    expect(settled).toBe(true);
    expect(fake.stdin).toEqual(['good']);
    connection.close();
  });

  it('a wrong password costs exactly one attempt: nothing is sent after it, the process is killed, and the host is not tried again', async () => {
    const h = sshHost({ useSudo: true, password: 'wrong' }, 'right');
    await expect(connectRemoteUsage('env', '')).rejects.toBeInstanceOf(RemoteAuthError);
    const fake = h.fake.current!;
    // sudo -S would have taken further lines as tries 2 and 3 (and read the request as a password).
    expect(fake.attempts).toBe(1);
    expect(fake.stdin).toEqual(['wrong']);
    expect(fake.requests).toEqual([]);
    expect(fake.killed).toBe(true);
    expect(h.end).toHaveBeenCalled();
    expect(isRemoteAuthFailed('env')).toBe(true);

    // Neither timers nor a new caller re-sends it.
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    for (let i = 0; i < 10; i++) await expect(connectRemoteUsage('env', '')).rejects.toBeInstanceOf(RemoteAuthError);
    expect(h.spawn).toHaveBeenCalledOnce();
    expect(vi.mocked(connectSshControl)).toHaveBeenCalledOnce();
  });

  it('treats silence after the password as a refusal when sudo answers in another language', async () => {
    const h = sshHost({ useSudo: true, password: 'wrong' }, 'right', false);
    const connecting = connectRemoteUsage('env', '');
    const failed = expect(connecting).rejects.toBeInstanceOf(RemoteAuthError);
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS - 1);
    expect(h.fake.current!.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await failed;
    expect(h.fake.current!.attempts).toBe(1);
    expect(h.fake.current!.stdin).toEqual(['wrong']);
    expect(h.fake.current!.killed).toBe(true);
    await expect(connectRemoteUsage('env', '')).rejects.toBeInstanceOf(RemoteAuthError);
    expect(h.spawn).toHaveBeenCalledOnce();
  });

  it('sends no password to a sudo that wants one it was not given, and does not retry', async () => {
    const h = sshHost({ useSudo: true }, null);
    await expect(connectRemoteUsage('env', '')).rejects.toBeInstanceOf(RemoteAuthError);
    expect(h.fake.current!.stdin).toEqual([]);
    await expect(connectRemoteUsage('env', '')).rejects.toBeInstanceOf(RemoteAuthError);
    expect(h.spawn).toHaveBeenCalledOnce();
  });

  it('a login the host refuses is also not retried', async () => {
    vi.mocked(getEnvironment).mockReturnValue({ type: 'ssh', config: '{}' } as never);
    vi.mocked(resolveSshConfig).mockResolvedValue({ useSudo: false, password: 'x' } as never);
    vi.mocked(connectSshControl).mockRejectedValue(new Error('All configured authentication methods failed'));
    await expect(connectRemoteUsage('env', '')).rejects.toBeInstanceOf(RemoteAuthError);
    await expect(connectRemoteUsage('env', '')).rejects.toBeInstanceOf(RemoteAuthError);
    expect(vi.mocked(connectSshControl)).toHaveBeenCalledOnce();
  });

  it('a reader that exits or never starts without a refusal is an ordinary failure that may be retried', async () => {
    const h = sshHost({ useSudo: false }, null);
    h.spawn.mockImplementationOnce(async () => {
      const fake = new FakeSudo('sh -lc x', null);
      Object.defineProperty(fake, 'start', { value: () => {} });
      h.fake.current = fake;
      const proc = fake.process();
      defer(() => proc.kill());
      return proc;
    });
    const first = connectRemoteUsage('env', '');
    await expect(first).rejects.not.toBeInstanceOf(RemoteAuthError);
    expect(isRemoteAuthFailed('env')).toBe(false);
    h.spawn.mockImplementation(async (command: string) => { h.fake.current = new FakeSudo(command, null); return h.fake.current.process(); });
    await expect(connectRemoteUsage('env', '')).resolves.toBeDefined();
  });

  it('applies the same handshake to a resident Coder reader, without treating a slow start as a refused login', async () => {
    vi.mocked(getEnvironment).mockReturnValue({ type: 'coder', config: '{}' } as never);
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn() });
    spawnMock.mockReturnValueOnce(child);
    const written: string[] = [];
    child.stdin.on('data', (d: Buffer) => written.push(d.toString()));
    const connecting = connectRemoteUsage('env', 'ws', undefined, { resident: true });
    const failed = expect(connecting).rejects.not.toBeInstanceOf(RemoteAuthError);
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS);
    await failed;
    expect(child.kill).toHaveBeenCalled();
    expect(written).toEqual([]);
    expect(isRemoteAuthFailed('env')).toBe(false);
  });
});
