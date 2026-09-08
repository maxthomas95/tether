import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteUsageService, type RemoteUsageSession } from './remote-usage-service';
import { UsageService } from './usage-service';
import { getDb } from '../db/database';
import type { RemoteUsageReply, RemoteUsageSource } from './remote-protocol';

vi.mock('electron', () => ({ app: { getPath: () => '' } }));
vi.mock('../db/database');
vi.mock('../logger', () => ({ createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn() }) }));
vi.mock('./remote-command', () => ({ connectRemoteUsage: vi.fn() }));
vi.mock('../claude/transcripts', () => ({ transcriptPath: vi.fn(), scanAllTranscripts: () => [] }));
vi.mock('../codex/transcripts', () => ({ scanAllCodexTranscripts: () => [] }));
vi.mock('../opencode/usage-reader', () => ({ readCrushSessions: () => [] }));

const source: RemoteUsageSource = { scope: 'user-home', path: '/remote/rollout.jsonl', nativeSessionId: 'native', identity: 'inode' };
const message = JSON.stringify({ type: 'assistant', timestamp: '2026-09-07T10:00:00Z', message: { model: 'claude-sonnet-4', usage: { input_tokens: 20, output_tokens: 3 } } }) + '\n';
const reply: RemoteUsageReply = { status: 'ready', source, offset: 200, text: message, reset: false, more: false };
let remote: RemoteUsageService;
let usage: UsageService;

function options(id = 'pane'): RemoteUsageSession {
  return { sessionId: id, environmentId: 'env', workspace: '', workingDir: '/work', cli: 'claude', nativeSessionId: 'native', onSource: vi.fn(), onStatus: vi.fn() };
}

beforeEach(() => { vi.useFakeTimers(); getDb().usageSummaries = []; usage = new UsageService(); });
afterEach(() => { remote?.dispose(); usage.dispose(); vi.useRealTimers(); });

describe('remote usage collection lifecycle', () => {
  it('persists cursors, retries disconnects, and never recounts a chunk', async () => {
    const poll = vi.fn()
      .mockResolvedValueOnce({ status: 'ready', source })
      .mockResolvedValueOnce(reply)
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValue({ ...reply, text: '', offset: 200 });
    const close = vi.fn();
    const connect = vi.fn(async () => ({ poll, close }));
    remote = new RemoteUsageService(connect, usage);
    const o = options();
    remote.start(o);
    await vi.advanceTimersByTimeAsync(0);
    expect(usage.getAll().byEnvironment?.[0].totalTokens).toBe(23);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(o.onStatus).toHaveBeenLastCalledWith('unavailable');
    expect(close).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(poll.mock.calls.at(-1)?.[0].cursor).toEqual({ offset: 200, identity: 'inode' });
    expect(usage.getAll().byEnvironment?.[0].totalTokens).toBe(23);
    expect(o.onStatus).toHaveBeenLastCalledWith('collecting');
    expect(getDb().usageSummaries[0].remote).toEqual(source);
  });

  it('restores the Codex model and byte cursor after restart without reading remote paths locally', () => {
    const key = 'remote:codex';
    usage.trackRemote(key, '/work', 'codex', 'env', source);
    usage.applyRemote(key, { ...reply, offset: 80, text: JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5' } }) + '\n' });
    const restarted = new UsageService();
    expect(restarted.trackRemote(key, '/work', 'codex', 'env', source)).toEqual({ offset: 80, identity: 'inode' });
    restarted.applyRemote(key, { ...reply, text: JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, output_tokens: 4 } } } }) + '\n' });
    expect(restarted.getSessionUsage(key)?.models[0].model).toBe('gpt-5');
    restarted.applyRemote(key, { ...reply, text: message });
    expect(restarted.getSessionUsage(key)?.inputTokens).toBe(10);
    restarted.dispose();
  });

  it('resets totals when the remote file is replaced', () => {
    usage.trackRemote('remote:a', '/work', 'claude', 'env', source);
    usage.applyRemote('remote:a', reply);
    usage.applyRemote('remote:a', { ...reply, source: { ...source, identity: 'replacement' }, reset: true });
    expect(usage.getSessionUsage('remote:a')?.inputTokens).toBe(20);
  });

  it('shares a connection per workspace and separates different workspaces', async () => {
    const connect = vi.fn(async () => ({ poll: vi.fn(async () => ({ status: 'pending' as const })), close: vi.fn() }));
    remote = new RemoteUsageService(connect, usage);
    remote.start(options('a'));
    remote.start(options('b'));
    remote.start({ ...options('c'), workspace: 'different-workspace' });
    await vi.advanceTimersByTimeAsync(0);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('does a final read after an exit during an in-flight poll, then closes the connection', async () => {
    let finish!: (value: RemoteUsageReply) => void;
    const poll = vi.fn()
      .mockResolvedValueOnce({ status: 'ready', source })
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue({ ...reply, text: message, offset: 400 });
    const close = vi.fn();
    remote = new RemoteUsageService(async () => ({ poll, close }), usage);
    remote.start(options());
    await vi.advanceTimersByTimeAsync(0);
    remote.stop('pane');
    finish(reply);
    await vi.advanceTimersByTimeAsync(250);
    expect(poll).toHaveBeenCalledTimes(3);
    expect(usage.getAll().byEnvironment?.[0].totalTokens).toBe(46);
    expect(close).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(poll).toHaveBeenCalledTimes(3);
  });

  it('closes a late connection and ignores late replies after disposal', async () => {
    let connected!: (value: { poll: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }) => void;
    const poll = vi.fn();
    const close = vi.fn();
    remote = new RemoteUsageService(() => new Promise(resolve => { connected = resolve; }), usage);
    remote.start(options());
    remote.dispose();
    connected({ poll, close });
    await vi.advanceTimersByTimeAsync(0);
    expect(close).toHaveBeenCalledOnce();
    expect(poll).not.toHaveBeenCalled();
    expect(usage.getAll().totalCost).toBe(0);
  });

  it('keeps a healthy CLI collecting when another CLI on the same environment cannot read its files', async () => {
    const poll = vi.fn(async (request: { marker: string; cursor?: unknown }) => {
      if (request.marker === 'broken') throw new Error('unreadable');
      return request.cursor ? reply : { status: 'ready' as const, source };
    });
    remote = new RemoteUsageService(async () => ({ poll, close: vi.fn() }), usage);
    const healthy = options('healthy');
    remote.start(options('broken'));
    remote.start(healthy);
    await vi.advanceTimersByTimeAsync(0);
    expect(healthy.onStatus).toHaveBeenLastCalledWith('collecting');
    expect(usage.getAll().byEnvironment?.[0].totalTokens).toBe(23);
  });

  it('does not remove a successor group when a cancelled connection completes late', async () => {
    let finish!: (value: { poll: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }) => void;
    const poll = vi.fn(async () => ({ status: 'pending' as const }));
    const close = vi.fn();
    const connect = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue({ poll, close });
    remote = new RemoteUsageService(connect, usage);
    remote.start(options('old'));
    remote.dispose();
    remote.start(options('new'));
    finish({ poll: vi.fn(), close: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    remote.stop('new');
    await vi.advanceTimersByTimeAsync(0);
    expect(close).toHaveBeenCalledOnce();
  });
});
