import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteUsageService, type RemoteUsageSession } from './remote-usage-service';
import { UsageService } from './usage-service';
import { getDb } from '../db/database';
import { RemoteAuthError, clearRemoteAuthFailure, markRemoteAuthFailed, resetRemoteAuthState } from './remote-auth-state';
import type { RemoteUsageSource } from './remote-protocol';

vi.mock('electron', () => ({ app: { getPath: () => '' } }));
vi.mock('../db/database');
vi.mock('../logger', () => ({ createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn() }) }));
vi.mock('./remote-command', () => ({ connectRemoteUsage: vi.fn() }));
vi.mock('../claude/transcripts', () => ({ transcriptPath: vi.fn(), scanAllTranscripts: () => [] }));
vi.mock('../codex/transcripts', () => ({ scanAllCodexTranscripts: () => [] }));
vi.mock('../opencode/usage-reader', () => ({ readCrushSessions: () => [] }));

const source: RemoteUsageSource = { scope: 'user-home', path: '/remote/rollout.jsonl', nativeSessionId: 'native', identity: 'inode' };
let remote: RemoteUsageService;
let usage: UsageService;

function options(id = 'pane'): RemoteUsageSession {
  return { sessionId: id, environmentId: 'env', workspace: '', workingDir: '/work', cli: 'claude', nativeSessionId: 'native', onSource: vi.fn(), onStatus: vi.fn() };
}

beforeEach(() => { vi.useFakeTimers(); resetRemoteAuthState(); getDb().usageSummaries = []; usage = new UsageService(); });
afterEach(() => { remote?.dispose(); usage.dispose(); vi.useRealTimers(); });

describe('remote usage after the host refuses the credentials', () => {
  it('tries once, reports unavailable, never retries on a timer, and reads again once the credentials are cleared', async () => {
    const poll = vi.fn()
      .mockResolvedValueOnce({ status: 'ready', source })
      .mockResolvedValue({ status: 'ready', source, offset: 0, text: '', reset: false, more: false });
    const connect = vi.fn()
      .mockImplementationOnce(async () => { markRemoteAuthFailed('env'); throw new RemoteAuthError(); })
      .mockResolvedValue({ poll, close: vi.fn() });
    remote = new RemoteUsageService(connect as never, usage);
    const o = options();
    remote.start(o);
    await vi.advanceTimersByTimeAsync(0);
    expect(o.onStatus).toHaveBeenLastCalledWith('unavailable');
    expect(connect).toHaveBeenCalledOnce();

    // A day of the old flat 30s retry would be 2,880 more logons.
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(connect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);

    // Another session on the same host does not re-send the password either.
    const second = options('pane-2');
    remote.start(second);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connect).toHaveBeenCalledOnce();
    expect(second.onStatus).toHaveBeenLastCalledWith('unavailable');

    clearRemoteAuthFailure('env');
    await vi.advanceTimersByTimeAsync(0);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(o.onStatus).toHaveBeenLastCalledWith('collecting');
  });

  it('does not even ask the connector while the environment is marked failed', async () => {
    markRemoteAuthFailed('env');
    const connect = vi.fn();
    remote = new RemoteUsageService(connect as never, usage);
    const o = options();
    remote.start(o);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(connect).not.toHaveBeenCalled();
    expect(o.onStatus).toHaveBeenLastCalledWith('unavailable');
  });

  it('still retries an ordinary connection failure on its normal interval', async () => {
    const connect = vi.fn().mockRejectedValue(new Error('network down'));
    remote = new RemoteUsageService(connect as never, usage);
    remote.start(options());
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('lets a failed session stop cleanly without touching the network', async () => {
    markRemoteAuthFailed('env');
    const connect = vi.fn();
    remote = new RemoteUsageService(connect as never, usage);
    remote.start(options());
    await vi.advanceTimersByTimeAsync(0);
    remote.stop('pane');
    await vi.advanceTimersByTimeAsync(0);
    expect(connect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
