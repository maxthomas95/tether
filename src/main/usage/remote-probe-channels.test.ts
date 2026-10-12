import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKOFF_MS, RemoteProbeChannels } from './remote-probe-channels';
import type { RemoteProbeTarget, RemoteSubagentRequest } from './remote-protocol';
import type { RemoteUsageConnection } from './remote-command';

vi.mock('../logger', () => ({ createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn() }) }));

const ssh: RemoteProbeTarget = { environmentId: 'ssh-env', workspace: '', workingDir: '/work' };
const coderA: RemoteProbeTarget = { environmentId: 'coder-env', workspace: 'owner/a', workingDir: '.' };
const coderB: RemoteProbeTarget = { ...coderA, workspace: 'owner/b' };
const request: RemoteSubagentRequest = { op: 'subagents', cli: 'claude', sessionId: 's', workingDir: '/work' };
const reply = { op: 'subagents', status: 'ready', found: false, agents: [], total: 0, more: false, now: 0 };

function fakeConnection() {
  const poll = vi.fn(async () => reply);
  const connection = { poll, close: vi.fn(), isDead: vi.fn(() => false) };
  return { connection: connection as unknown as RemoteUsageConnection, poll, close: connection.close, isDead: connection.isDead };
}

let clock: number;
beforeEach(() => { vi.useFakeTimers(); clock = 1_000_000; });
afterEach(() => vi.useRealTimers());
const channels = (connect: ReturnType<typeof vi.fn>) => new RemoteProbeChannels(connect as never, () => clock);

describe('RemoteProbeChannels', () => {
  it('starts one reader per host however many sessions and polls use it, and asks for a resident one', async () => {
    const { connection, poll } = fakeConnection();
    const connect = vi.fn(async () => connection);
    const pool = channels(connect);
    const [one, two] = [pool.acquire(ssh), pool.acquire(ssh)];
    await Promise.all([one.call(request), two.call(request), one.call(request)]);
    for (let i = 0; i < 25; i++) await (i % 2 ? one : two).call(request);
    expect(connect).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledWith('ssh-env', '', expect.any(AbortSignal), { resident: true });
    expect(poll).toHaveBeenCalledTimes(28);
  });

  it('keeps Coder workspaces apart but shares SSH sessions of one environment', async () => {
    const connect = vi.fn(async () => fakeConnection().connection);
    const pool = channels(connect);
    await pool.acquire(coderA).call(request);
    await pool.acquire(coderB).call(request);
    await pool.acquire(coderA).call(request);
    await pool.acquire({ ...ssh, workingDir: '/elsewhere' }).call(request);
    await pool.acquire(ssh).call(request);
    expect(connect.mock.calls.map(c => c[1])).toEqual(['owner/a', 'owner/b', '']);
  });

  it('does not retry a reader that failed to start until the backoff has passed, then backs off further', async () => {
    const ok = fakeConnection();
    const connect = vi.fn()
      .mockRejectedValueOnce(new Error('sudo: a password is required'))
      .mockRejectedValueOnce(new Error('sudo: a password is required'))
      .mockResolvedValue(ok.connection);
    const pool = channels(connect);
    const lease = pool.acquire(ssh);
    await expect(lease.call(request)).rejects.toThrow();
    // A tracker polling every few seconds must not turn into a login every few seconds.
    for (let i = 0; i < 20; i++) { clock += 1_000; await expect(lease.call(request)).rejects.toThrow('unavailable'); }
    expect(connect).toHaveBeenCalledTimes(1);

    clock += BACKOFF_MS[0];
    await expect(lease.call(request)).rejects.toThrow();
    expect(connect).toHaveBeenCalledTimes(2);
    clock += BACKOFF_MS[0];
    await expect(lease.call(request)).rejects.toThrow('unavailable');
    expect(connect).toHaveBeenCalledTimes(2);
    clock += BACKOFF_MS[1];
    await expect(lease.call(request)).resolves.toBeDefined();
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it('shares one in-flight start among concurrent first calls', async () => {
    let release!: (c: RemoteUsageConnection) => void;
    const connect = vi.fn(() => new Promise<RemoteUsageConnection>(resolve => { release = resolve; }));
    const pool = channels(connect);
    const calls = [pool.acquire(ssh).call(request), pool.acquire(ssh).call(request)];
    await vi.advanceTimersByTimeAsync(0);
    release(fakeConnection().connection);
    await Promise.all(calls);
    expect(connect).toHaveBeenCalledOnce();
  });

  it('replaces a reader that died, once, behind the backoff', async () => {
    const dead = fakeConnection();
    dead.poll.mockRejectedValue(new Error('Remote usage reader unavailable'));
    dead.isDead.mockReturnValue(true);
    const fresh = fakeConnection();
    const connect = vi.fn().mockResolvedValueOnce(dead.connection).mockResolvedValue(fresh.connection);
    const lease = channels(connect).acquire(ssh);
    await expect(lease.call(request)).rejects.toThrow();
    expect(dead.close).toHaveBeenCalledOnce();
    await expect(lease.call(request)).rejects.toThrow('unavailable');
    expect(connect).toHaveBeenCalledOnce();
    clock += BACKOFF_MS[0];
    await expect(lease.call(request)).resolves.toBeDefined();
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('keeps a live reader through isolated request failures but replaces one that keeps failing', async () => {
    const flaky = fakeConnection();
    flaky.poll.mockRejectedValueOnce(new Error('Invalid remote usage reply')).mockResolvedValue(reply);
    const connect = vi.fn(async () => flaky.connection);
    const pool = channels(connect);
    const lease = pool.acquire(ssh);
    await expect(lease.call(request)).rejects.toThrow();
    await expect(lease.call(request)).resolves.toBeDefined();
    expect(flaky.close).not.toHaveBeenCalled();

    const broken = fakeConnection();
    broken.poll.mockRejectedValue(new Error('Remote usage command timed out'));
    const pool2 = channels(vi.fn(async () => broken.connection));
    const lease2 = pool2.acquire(ssh);
    for (let i = 0; i < 3; i++) await expect(lease2.call(request)).rejects.toThrow();
    expect(broken.close).toHaveBeenCalledOnce();
  });

  it('closes a reader nobody holds after a grace period, but not if a session returns first', async () => {
    const { connection, close } = fakeConnection();
    const connect = vi.fn(async () => connection);
    const pool = channels(connect);
    const first = pool.acquire(ssh);
    await first.call(request);
    first.release();
    first.release();
    await vi.advanceTimersByTimeAsync(30_000);
    const back = pool.acquire(ssh);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(close).not.toHaveBeenCalled();
    back.release();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(close).toHaveBeenCalledOnce();
    expect(pool.openCount).toBe(0);
    await expect(back.call(request)).rejects.toThrow('unavailable');
  });

  it('keeps the reader open for as long as any session holds it, and closes only after the last lets go', async () => {
    const { connection, close, poll } = fakeConnection();
    const connect = vi.fn(async () => connection);
    const pool = channels(connect);
    const [one, two] = [pool.acquire(ssh), pool.acquire(ssh)];
    await one.call(request);

    // Hours with no polling at all: a hook-driven session between subagent bursts.
    await vi.advanceTimersByTimeAsync(8 * 60 * 60_000);
    one.release();
    await vi.advanceTimersByTimeAsync(8 * 60 * 60_000);
    expect(close).not.toHaveBeenCalled();
    await two.call(request);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenCalledOnce();

    two.release();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes every reader on dispose', async () => {
    const a = fakeConnection();
    const b = fakeConnection();
    const connect = vi.fn().mockResolvedValueOnce(a.connection).mockResolvedValueOnce(b.connection);
    const pool = channels(connect);
    await pool.acquire(coderA).call(request);
    await pool.acquire(coderB).call(request);
    pool.dispose();
    expect(a.close).toHaveBeenCalledOnce();
    expect(b.close).toHaveBeenCalledOnce();
  });
});
