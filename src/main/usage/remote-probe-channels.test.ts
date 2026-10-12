import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKOFF_MS, HEALTHY_MS, RemoteProbeChannels } from './remote-probe-channels';
import { RemoteProbeRequestError } from './remote-command';
import { RemoteAuthError, clearRemoteAuthFailure, markRemoteAuthFailed, resetRemoteAuthState } from './remote-auth-state';
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
beforeEach(() => { vi.useFakeTimers(); clock = 1_000_000; resetRemoteAuthState(); });
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

  it('keeps a live reader through error replies and slow requests, however often, while other sessions are served', async () => {
    const reader = fakeConnection();
    // Session A's request always errors; session B's always works; A is also sometimes slow.
    reader.poll.mockImplementation(async (r: unknown) => {
      if ((r as { sessionId: string }).sessionId === 'bad') throw new RemoteProbeRequestError('Invalid remote subagent reply', 'reply');
      return reply;
    });
    const connect = vi.fn(async () => reader.connection);
    const pool = channels(connect);
    const [good, bad] = [pool.acquire(ssh), pool.acquire(ssh)];
    for (let i = 0; i < 60; i++) {
      await expect(bad.call({ ...request, sessionId: 'bad' })).rejects.toThrow();
      await good.call(request);
      clock += 30_000;
    }
    reader.poll.mockRejectedValueOnce(new RemoteProbeRequestError('Remote usage command timed out', 'timeout'));
    await expect(good.call(request)).rejects.toThrow('timed out');
    await good.call(request);
    expect(connect).toHaveBeenCalledOnce();
    expect(reader.close).not.toHaveBeenCalled();
  });

  it('replaces a reader that answers nothing for several requests in a row, once, behind the backoff', async () => {
    const hung = fakeConnection();
    hung.poll.mockRejectedValue(new RemoteProbeRequestError('Remote usage command timed out', 'timeout'));
    const fresh = fakeConnection();
    const connect = vi.fn().mockResolvedValueOnce(hung.connection).mockResolvedValue(fresh.connection);
    const lease = channels(connect).acquire(ssh);
    for (let i = 0; i < 3; i++) await expect(lease.call(request)).rejects.toThrow('timed out');
    expect(hung.close).toHaveBeenCalledOnce();
    await expect(lease.call(request)).rejects.toThrow('unavailable');
    expect(connect).toHaveBeenCalledOnce();
  });

  it('forgives the backoff only after the reader has stayed healthy for a long time, not on one success', async () => {
    const readers = Array.from({ length: 4 }, () => fakeConnection());
    const connect = vi.fn();
    readers.forEach(r => connect.mockResolvedValueOnce(r.connection));
    connect.mockResolvedValue(fakeConnection().connection);
    const pool = channels(connect);
    const lease = pool.acquire(ssh);
    const dieAfterOneGoodCall = async (reader: ReturnType<typeof fakeConnection>) => {
      await lease.call(request);                       // one success must not reset anything
      reader.poll.mockRejectedValueOnce(new RemoteProbeRequestError('Remote usage reader unavailable', 'dead'));
      await expect(lease.call(request)).rejects.toThrow();
    };
    await dieAfterOneGoodCall(readers[0]);
    clock += BACKOFF_MS[0];
    await dieAfterOneGoodCall(readers[1]);
    // Second death: the wait is the second step, not the first.
    clock += BACKOFF_MS[0];
    await expect(lease.call(request)).rejects.toThrow('unavailable');
    clock += BACKOFF_MS[1];
    await dieAfterOneGoodCall(readers[2]);
    expect(connect).toHaveBeenCalledTimes(3);

    // A reader that then runs for a long time starts over from the first step.
    clock += BACKOFF_MS[2];
    await lease.call(request);
    clock += HEALTHY_MS;
    await lease.call(request);
    readers[3].poll.mockRejectedValueOnce(new RemoteProbeRequestError('Remote usage reader unavailable', 'dead'));
    await expect(lease.call(request)).rejects.toThrow();
    clock += BACKOFF_MS[0];
    await expect(lease.call(request)).resolves.toBeDefined();
  });

  it('keeps the backoff across the host being dropped and picked up again', async () => {
    const connect = vi.fn().mockRejectedValue(new Error('connect failed'));
    const pool = channels(connect);
    const first = pool.acquire(ssh);
    await expect(first.call(request)).rejects.toThrow('connect failed');
    first.release();
    await vi.advanceTimersByTimeAsync(61_000);       // the idle grace drops the host entry
    const again = pool.acquire(ssh);
    await expect(again.call(request)).rejects.toThrow('unavailable');
    expect(connect).toHaveBeenCalledOnce();
    clock += BACKOFF_MS[0];
    await expect(again.call(request)).rejects.toThrow('connect failed');
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('does not touch the network for a host whose credentials were refused, and tries again once they are cleared', async () => {
    const connect = vi.fn(async () => { markRemoteAuthFailed('ssh-env'); throw new RemoteAuthError(); });
    const pool = channels(connect);
    const lease = pool.acquire(ssh);
    await expect(lease.call(request)).rejects.toBeInstanceOf(RemoteAuthError);
    for (let i = 0; i < 50; i++) { clock += 600_000; await expect(lease.call(request)).rejects.toBeInstanceOf(RemoteAuthError); }
    lease.release();
    await vi.advanceTimersByTimeAsync(61_000);
    await expect(pool.acquire(ssh).call(request)).rejects.toBeInstanceOf(RemoteAuthError);
    expect(connect).toHaveBeenCalledOnce();

    clearRemoteAuthFailure('ssh-env');
    connect.mockResolvedValue(fakeConnection().connection as never);
    await expect(pool.acquire(ssh).call(request)).resolves.toBeDefined();
    expect(connect).toHaveBeenCalledTimes(2);
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
