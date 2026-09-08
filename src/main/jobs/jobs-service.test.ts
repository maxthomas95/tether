import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_JOBS_SETTINGS } from '../../shared/jobs';
import type { JobsSettings } from '../../shared/types';

const mocks = vi.hoisted(() => ({
  cfg: {} as JobsSettings, read: vi.fn(), spawn: vi.fn(), spawnSync: vi.fn(), exists: vi.fn(),
}));
vi.mock('./jobs-config', () => ({ readJobsConfig: mocks.read }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn, spawnSync: mocks.spawnSync }));
vi.mock('node:fs', () => ({ default: { existsSync: mocks.exists } }));
vi.mock('../logger', () => ({ createLogger: () => ({ info: vi.fn() }) }));
import { JobsService } from './jobs-service';

let service: JobsService;
let child: ChildProcess & { kill: ReturnType<typeof vi.fn> };
let fetchMock: ReturnType<typeof vi.fn>;
const healthy = () => new Response(JSON.stringify({ app: 'jobs', version: '1.2' }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  mocks.cfg = { ...DEFAULT_JOBS_SETTINGS };
  mocks.read.mockImplementation(() => ({ ...mocks.cfg }));
  mocks.exists.mockReturnValue(true);
  mocks.spawnSync.mockReturnValue({ status: 0 });
  child = Object.assign(new EventEmitter(), { kill: vi.fn() }) as unknown as typeof child;
  child.kill.mockImplementation(() => { queueMicrotask(() => child.emit('exit', 0)); return true; });
  mocks.spawn.mockReturnValue(child);
  fetchMock = vi.fn().mockResolvedValue(healthy());
  vi.stubGlobal('fetch', fetchMock);
  service = new JobsService();
});
afterEach(() => { service.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('does not probe or launch when disabled, even over periodic ticks', async () => {
  service.start();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(mocks.spawn).not.toHaveBeenCalled();
  expect(service.getStatus()).toMatchObject({ enabled: 'off', phase: 'off' });
});

it('ignores a pending health response after opt-out', async () => {
  const pending = deferred<Response>();
  fetchMock.mockReturnValueOnce(pending.promise);
  mocks.cfg.enabled = 'auto';
  const first = service.refresh();
  const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
  mocks.cfg.enabled = 'off';
  await service.refresh();
  expect(signal.aborted).toBe(true);
  pending.resolve(healthy());
  await first;
  expect(service.getStatus()).toMatchObject({ enabled: 'off', detected: false });
  expect(mocks.spawn).not.toHaveBeenCalled();
});

it('does not let a previous server overwrite a new connection', async () => {
  const pending = deferred<Response>();
  fetchMock.mockReturnValueOnce(pending.promise);
  mocks.cfg.enabled = 'auto';
  const first = service.refresh();
  mocks.cfg.url = 'https://office.example';
  await service.refresh();
  pending.resolve(healthy());
  await first;
  expect(service.getStatus()).toMatchObject({ url: 'https://office.example', detected: true, managed: false });
});

it('identifies foreign services and disallows redirected probes', async () => {
  mocks.cfg = { ...mocks.cfg, enabled: 'auto', path: '/office', autoLaunch: true };
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ app: 'something-else' })));
  await service.refresh();
  expect(service.getStatus().error).toContain('not a JOBS office');
  expect(fetchMock.mock.calls[0][1].redirect).toBe('error');
  expect(mocks.spawn).not.toHaveBeenCalled();
});

it('does not auto-launch just because a folder is saved', async () => {
  mocks.cfg = { ...mocks.cfg, enabled: 'auto', path: '/office', autoLaunch: false };
  fetchMock.mockRejectedValue(new Error('offline'));
  await service.refresh();
  expect(mocks.spawn).not.toHaveBeenCalled();
});

it('does not restart or kill an independently running server', async () => {
  mocks.cfg = { ...mocks.cfg, enabled: 'auto', path: '/office', autoLaunch: true };
  await service.refresh();
  mocks.cfg.enabled = 'off';
  await service.refresh();
  expect(mocks.spawn).not.toHaveBeenCalled();
  expect(child.kill).not.toHaveBeenCalled();
});

it('starts a built checkout explicitly and ignores its pending startup probe after opt-out', async () => {
  mocks.cfg = { ...mocks.cfg, enabled: 'auto', path: '/office', autoLaunch: true, token: 'secret' };
  fetchMock.mockRejectedValueOnce(new Error('offline'));
  await service.refresh();
  expect(service.getStatus()).toMatchObject({ phase: 'starting', managed: true });
  expect(mocks.spawn.mock.calls[0][2]).toMatchObject({ env: { PORT: '8780', JOBS_TOKEN: 'secret', WEBHOOK_TOKEN: 'secret' }, stdio: 'ignore', windowsHide: true });
  const pending = deferred<Response>();
  fetchMock.mockReturnValueOnce(pending.promise);
  await vi.advanceTimersByTimeAsync(1_000);
  mocks.cfg.enabled = 'off';
  await service.refresh();
  expect(child.kill).toHaveBeenCalledOnce();
  pending.resolve(healthy());
  await vi.advanceTimersByTimeAsync(1_000);
  expect(service.getStatus()).toMatchObject({ enabled: 'off', detected: false, managed: false });
});

it('replaces its owned child when launch settings change and ignores late child events', async () => {
  mocks.cfg = { ...mocks.cfg, enabled: 'auto', path: '/office', autoLaunch: true };
  fetchMock.mockRejectedValueOnce(new Error('offline'));
  await service.refresh();
  mocks.cfg.url = 'https://external.example';
  mocks.cfg.autoLaunch = false;
  await service.refresh();
  child.emit('exit', 1);
  expect(child.kill).toHaveBeenCalledOnce();
  expect(service.getStatus()).toMatchObject({ detected: true, managed: false, url: 'https://external.example' });
});

it('reports an unhealthy managed server instead of leaving a stale connected office', async () => {
  mocks.cfg = { ...mocks.cfg, enabled: 'auto', path: '/office', autoLaunch: true };
  fetchMock.mockRejectedValueOnce(new Error('offline'));
  service.start();
  await vi.advanceTimersByTimeAsync(1_001);
  expect(service.getStatus().detected).toBe(true);
  fetchMock.mockRejectedValue(new Error('offline'));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(service.getStatus()).toMatchObject({ detected: false, phase: 'unavailable', managed: true });
});

it('reports missing build output and never falls back to spawning another Electron app', async () => {
  mocks.cfg = { ...mocks.cfg, enabled: 'auto', path: '/office', autoLaunch: true };
  fetchMock.mockRejectedValue(new Error('offline'));
  mocks.exists.mockReturnValue(false);
  await service.refresh();
  expect(service.getStatus().error).toContain('not built');
  mocks.exists.mockReturnValue(true);
  mocks.spawnSync.mockReturnValue({ status: 1 });
  await service.refresh();
  expect(service.getStatus().error).toContain('Install Node.js');
  expect(mocks.spawn).not.toHaveBeenCalled();
});

it('invalidates probes on disposal', async () => {
  mocks.cfg.enabled = 'auto';
  const pending = deferred<Response>();
  fetchMock.mockReturnValue(pending.promise);
  const refresh = service.refresh();
  service.dispose();
  pending.resolve(healthy());
  await refresh;
  expect(service.getStatus().detected).toBe(false);
});

it('waits for its previous child to exit before probing or launching a replacement', async () => {
  mocks.cfg = { ...mocks.cfg, enabled: 'auto', path: '/office', autoLaunch: true };
  fetchMock.mockRejectedValue(new Error('offline'));
  await service.refresh();
  child.kill.mockImplementation(() => true);
  mocks.cfg.path = '/new-office';
  const refresh = service.refresh();
  await vi.advanceTimersByTimeAsync(100);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(mocks.spawn).toHaveBeenCalledOnce();
  child.emit('exit', 0);
  await refresh;
  expect(mocks.spawn).toHaveBeenCalledTimes(2);
});

it('continues startup polling when settings are saved again during launch', async () => {
  mocks.cfg = { ...mocks.cfg, enabled: 'auto', path: '/office', autoLaunch: true };
  fetchMock.mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('still starting'));
  await service.refresh();
  await service.refresh();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(service.getStatus()).toMatchObject({ detected: true, managed: true, phase: 'connected' });
  expect(mocks.spawn).toHaveBeenCalledOnce();
});

it('keeps the office connected while notifying the bridge that sharing was disabled', async () => {
  mocks.cfg = { ...mocks.cfg, enabled: 'auto', shareRemoteSessions: true };
  fetchMock.mockImplementation(async () => healthy());
  await service.refresh();
  const listener = vi.fn();
  service.onStatusChange(listener);
  mocks.cfg.shareRemoteSessions = false;
  await service.refresh();
  expect(listener).toHaveBeenCalledWith(expect.objectContaining({ detected: true, shareRemoteSessions: false }));
  expect(listener.mock.calls.every(([status]) => status.detected)).toBe(true);
});
