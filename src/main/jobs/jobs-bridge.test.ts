import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Session, SessionLifecycleObserver } from '../session/session-manager';
import type { JobsSettings, JobsStatus } from '../../shared/types';
import { DEFAULT_JOBS_SETTINGS } from '../../shared/jobs';

const state = vi.hoisted(() => ({
  cfg: {} as JobsSettings, status: {} as JobsStatus, sessions: new Map<string, Session>(),
  observer: {} as SessionLifecycleObserver, statusChanged: () => {}, bridgeError: vi.fn(),
}));
vi.mock('../session/session-manager', () => ({ sessionManager: {
  addLifecycleObserver: (observer: SessionLifecycleObserver) => { state.observer = observer; return () => {}; },
  listSessions: () => [...state.sessions.values()],
  getSession: (id: string) => state.sessions.get(id),
} }));
vi.mock('../db/environment-repo', () => ({ getEnvironment: (id: string) => ({ type: id, name: `Environment ${id}` }) }));
vi.mock('./jobs-config', () => ({ readJobsConfig: () => state.cfg }));
vi.mock('./jobs-service', () => ({ jobsService: {
  getStatus: () => state.status,
  onStatusChange: (cb: () => void) => { state.statusChanged = cb; return () => {}; },
  setBridgeError: state.bridgeError,
} }));
import { JobsBridge } from './jobs-bridge';

let bridge: JobsBridge;
let fetchMock: ReturnType<typeof vi.fn>;
function session(id: string, environmentId = 'ssh', sessionState = 'running'): Session {
  const value = { id, environmentId, state: sessionState, label: 'Test agent', workingDir: '/private/projects/demo', cliTool: 'codex' } as Session;
  state.sessions.set(id, value);
  return value;
}
const flush = async () => { await vi.advanceTimersByTimeAsync(0); };
const events = () => fetchMock.mock.calls.map(call => JSON.parse(call[1].body));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  state.cfg = { ...DEFAULT_JOBS_SETTINGS, enabled: 'auto', shareRemoteSessions: true, token: 'first-token' };
  state.status = { enabled: 'auto', url: state.cfg.url, detected: true, version: '1', managed: false };
  state.sessions.clear();
  fetchMock = vi.fn().mockResolvedValue(new Response('{}'));
  vi.stubGlobal('fetch', fetchMock);
  bridge = new JobsBridge();
});
afterEach(async () => { bridge.dispose(); await flush(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('shares only live remote sessions and sends metadata without full paths or terminal contents', async () => {
  session('ssh'); session('coder', 'coder'); session('local', 'local');
  session('stopped', 'ssh', 'stopped'); session('dead', 'ssh', 'dead');
  bridge.start();
  await flush();
  expect(events().map(event => event.source_id)).toEqual(['tether-ssh', 'tether-coder']);
  expect(events()[0]).toEqual({ event: 'start', source_id: 'tether-ssh', source_name: 'Test agent', source_type: 'tether', project: 'demo', machine: 'Environment ssh', state: 'running', activity: 'Running codex' });
});

it('allows office viewing without session sharing, then introduces sessions when sharing is enabled', async () => {
  state.cfg.shareRemoteSessions = false;
  session('remote');
  bridge.start();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fetchMock).not.toHaveBeenCalled();
  state.cfg.shareRemoteSessions = true;
  state.statusChanged();
  await flush();
  expect(events()[0].event).toBe('start');
});

it('finishes an in-flight start before removing the agent on opt-out and skips queued status updates', async () => {
  let resolve!: (response: Response) => void;
  fetchMock.mockReturnValueOnce(new Promise<Response>(r => { resolve = r; }));
  const remote = session('remote');
  bridge.start();
  await flush();
  remote.state = 'waiting';
  state.observer.onStateChanged?.(remote);
  state.cfg.enabled = 'off';
  state.status.enabled = 'off';
  state.status.detected = false;
  state.statusChanged();
  resolve(new Response('{}'));
  await flush();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(events().map(event => event.event)).toEqual(['start', 'stop']);
  expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer first-token');
});

it('removes agents from the previous endpoint with the previous token before switching', async () => {
  session('remote');
  bridge.start();
  await flush();
  state.cfg.url = state.status.url = 'https://new.example';
  state.cfg.token = 'new-token';
  state.statusChanged();
  await flush();
  expect(events().map(event => event.event)).toEqual(['start', 'stop', 'start']);
  expect(fetchMock.mock.calls[1][0]).toBe('http://localhost:8780/api/webhooks');
  expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer first-token');
  expect(fetchMock.mock.calls[2][0]).toBe('https://new.example/api/webhooks');
  expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe('Bearer new-token');
});

it('does not resurrect a stopped session when JOBS returns 404 for its stop', async () => {
  const remote = session('remote');
  bridge.start();
  await flush();
  fetchMock.mockResolvedValueOnce(new Response('{}', { status: 404 }));
  remote.state = 'stopped';
  state.observer.onStateChanged?.(remote);
  await flush();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(events().map(event => event.event)).toEqual(['start', 'stop']);
});

it('reintroduces a live session after a server restart with its latest state', async () => {
  const remote = session('remote');
  bridge.start();
  await flush();
  remote.state = 'waiting';
  remote.waitingReason = 'permission';
  fetchMock.mockResolvedValueOnce(new Response('{}', { status: 404 }));
  state.observer.onStateChanged?.(remote);
  await flush();
  expect(events().map(event => event.event)).toEqual(['start', 'status', 'start']);
  expect(events()[2]).toMatchObject({ state: 'waiting', activity: 'Awaiting permission' });
});

it('retries failed starts on the heartbeat and exposes rejected authentication', async () => {
  session('remote');
  fetchMock.mockResolvedValueOnce(new Response('{}', { status: 401 }));
  bridge.start();
  await flush();
  expect(state.bridgeError).toHaveBeenCalledWith(expect.stringContaining('webhook token'));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(events().map(event => event.event)).toEqual(['start', 'start']);
  expect(state.bridgeError).toHaveBeenLastCalledWith(undefined);
  expect(fetchMock.mock.calls[0][1].redirect).toBe('error');
});

it('treats 404 on start as failure and retries start rather than heartbeat', async () => {
  session('remote');
  fetchMock.mockResolvedValueOnce(new Response('{}', { status: 404 }));
  bridge.start();
  await flush();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(events().map(event => event.event)).toEqual(['start', 'start']);
});

it('stops failed and removed sessions and removes its agents on shutdown', async () => {
  const dead = session('dead'); session('removed'); session('live');
  bridge.start();
  await flush();
  dead.state = 'dead';
  state.observer.onStateChanged?.(dead);
  state.sessions.delete('removed');
  state.observer.onRemoved?.('removed');
  await flush();
  bridge.dispose();
  await flush();
  expect(events().filter(event => event.event === 'stop').map(event => event.source_id)).toEqual(['tether-dead', 'tether-removed', 'tether-live']);
});
