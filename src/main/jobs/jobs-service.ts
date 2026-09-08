import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../logger';
import { readJobsConfig } from './jobs-config';
import { JOBS_DEFAULT_URL, isJobsLoopback, normalizeJobsUrl } from '../../shared/jobs';
import type { JobsSettings, JobsStatus } from '../../shared/types';

const log = createLogger('jobs');
const PROBE_INTERVAL_MS = 60_000;
const PROBE_TIMEOUT_MS = 3_000;
const SPAWN_POLL_MS = 1_000;
const SPAWN_POLL_MAX = 15;

/** Only a real Node runtime works in packaged builds with RunAsNode disabled. */
function findNodeBinary(): string | null {
  const candidate = process.platform === 'win32' ? 'node.exe' : 'node';
  try {
    return spawnSync(candidate, ['--version'], { timeout: 3_000, windowsHide: true }).status === 0 ? candidate : null;
  } catch { return null; }
}

/** Positive identification only. Tether stops only children it started. */
export class JobsService {
  private status: JobsStatus = {
    enabled: 'off', url: JOBS_DEFAULT_URL, detected: false, version: null, managed: false, phase: 'off', shareRemoteSessions: false,
  };
  private config: JobsSettings | null = null;
  private child: ChildProcess | null = null;
  private childConfig: string | null = null;
  private stopping: { child: ChildProcess; done: Promise<void> } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private spawnPollTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<(status: JobsStatus) => void>();
  private launchAttempted = false;
  private disposed = false;
  private generation = 0;
  private probeController = new AbortController();

  getStatus(): JobsStatus { return { ...this.status }; }

  onStatusChange(cb: (status: JobsStatus) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  setBridgeError(error?: string): void {
    this.setStatus({ ...this.status, bridgeError: error });
  }

  start(): void {
    if (this.timer || this.disposed) return;
    void this.refresh();
    this.timer = setInterval(() => {
      if (this.config && this.config.enabled !== 'off') void this.tick(this.config, this.generation);
    }, PROBE_INTERVAL_MS);
  }

  async refresh(): Promise<JobsStatus> {
    if (this.disposed) return this.getStatus();
    const generation = ++this.generation;
    this.probeController.abort();
    this.probeController = new AbortController();
    this.clearSpawnPoll();
    this.launchAttempted = false;
    // Opt-out must work even when a previously saved token cannot be decrypted.
    let cfg = readJobsConfig(false);
    try {
      if (cfg.enabled !== 'off') cfg = { ...readJobsConfig(), url: normalizeJobsUrl(cfg.url) };
    } catch {
      this.config = null;
      this.stopManagedChild();
      this.setStatus({ enabled: cfg.enabled, url: cfg.url, detected: false, version: null,
        managed: false, phase: 'unavailable', error: 'Could not read JOBS settings. Check the server URL and saved token, or remove the integration.' });
      return this.getStatus();
    }
    const changed = !this.config || this.config.enabled !== cfg.enabled ||
      this.config.autoLaunch !== cfg.autoLaunch || this.launchKey(this.config) !== this.launchKey(cfg);
    this.config = cfg;
    if (cfg.enabled === 'off' || !cfg.autoLaunch || this.childConfig !== this.launchKey(cfg)) this.stopManagedChild();
    if (changed || !this.status.detected) {
      this.setStatus({ enabled: cfg.enabled, url: cfg.url, detected: false, version: null,
        managed: !!this.child, shareRemoteSessions: cfg.enabled !== 'off' && cfg.shareRemoteSessions,
        phase: cfg.enabled === 'off' ? 'off' : this.child && this.status.phase === 'starting' ? 'starting' : 'checking' });
    } else if (this.status.shareRemoteSessions !== cfg.shareRemoteSessions) {
      // Sharing can stop while the user keeps watching the connected office.
      this.setStatus({ ...this.status, shareRemoteSessions: cfg.shareRemoteSessions, bridgeError: undefined });
    }
    if (cfg.enabled !== 'off') {
      if (this.stopping) {
        const stopped = await this.waitForStop();
        if (!this.current(generation)) return this.getStatus();
        if (!stopped) {
          this.setError('Waiting for the previous JOBS server to stop. Try connecting again shortly.');
          return this.getStatus();
        }
      }
      await this.tick(cfg, generation);
    }
    return this.getStatus();
  }

  private current(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  private async tick(cfg: JobsSettings, generation: number): Promise<void> {
    if (!this.current(generation)) return;
    if (this.stopping) return;
    const probe = await this.probe(cfg.url);
    if (!this.current(generation)) return;
    if (probe.ok) {
      this.setStatus({ ...this.status, enabled: cfg.enabled, url: cfg.url, detected: true,
        version: probe.version, managed: !!this.child, phase: 'connected', error: undefined });
      return;
    }
    if (this.child && this.status.phase === 'starting') {
      this.pollAfterSpawn(cfg, generation, 0);
      return;
    }
    if (!this.child && cfg.autoLaunch && !this.launchAttempted && probe.unreachable) {
      this.launchAttempted = true;
      this.tryLaunch(cfg, generation);
      return;
    }
    this.setStatus({ ...this.status, detected: false, version: null, phase: 'unavailable',
      error: this.status.error || probe.error });
  }

  private async probe(url: string): Promise<{ ok: true; version: string | null } | { ok: false; error: string; unreachable?: boolean }> {
    try {
      const res = await fetch(`${url}/healthz`, {
        signal: AbortSignal.any([this.probeController.signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]),
        redirect: 'error',
      });
      if (!res.ok) return { ok: false, error: `JOBS health check returned HTTP ${res.status}. Check the URL and server.` };
      const body: unknown = await res.json().catch(() => null);
      if (!body || typeof body !== 'object' || !('app' in body) || body.app !== 'jobs') {
        return { ok: false, error: 'The server responded, but it is not a JOBS office. Check the URL and port.' };
      }
      return { ok: true, version: 'version' in body && typeof body.version === 'string' ? body.version : null };
    } catch {
      return { ok: false, unreachable: true, error: 'Could not reach JOBS. Start the server and check its URL, then save and connect again.' };
    }
  }

  private launchKey(cfg: JobsSettings): string {
    return JSON.stringify([cfg.url, cfg.path, cfg.token]);
  }

  private tryLaunch(cfg: JobsSettings, generation: number): void {
    const url = new URL(cfg.url);
    if (!cfg.path || url.protocol !== 'http:' || !isJobsLoopback(url) || url.pathname !== '/') {
      this.setError('Automatic launch needs a built JOBS folder and a local HTTP URL without a path.');
      return;
    }
    const entry = path.resolve(cfg.path, 'dist-server', 'server', 'index.js');
    if (!fs.existsSync(entry) || !fs.existsSync(path.resolve(cfg.path, 'dist', 'index.html'))) {
      this.setError('JOBS folder is not built. Run "npm install" and "npm run build" in that folder first.');
      return;
    }
    const runtime = findNodeBinary();
    if (!runtime) {
      this.setError('Install Node.js and restart Tether to launch JOBS, or run the server yourself.');
      return;
    }
    const env: NodeJS.ProcessEnv = { ...process.env, PORT: url.port || '80' };
    delete env.ELECTRON_RUN_AS_NODE;
    if (cfg.token) { env.JOBS_TOKEN = cfg.token; env.WEBHOOK_TOKEN = cfg.token; }
    let child: ChildProcess;
    try {
      // Do not copy an external server's output into Tether logs: it may contain secrets.
      child = spawn(runtime, [entry], { cwd: cfg.path, env, windowsHide: true, stdio: 'ignore' });
    } catch {
      this.setError('Could not launch JOBS. Check the folder and Node.js installation.');
      return;
    }
    this.child = child;
    this.childConfig = this.launchKey(cfg);
    this.setStatus({ ...this.status, detected: false, managed: true, phase: 'starting', error: undefined });
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.childConfig = null;
      this.clearSpawnPoll();
      this.setError(`JOBS server exited${code === null ? '' : ` with code ${code}`}. Check the server setup and try again.`);
    });
    child.on('error', () => {
      if (this.child !== child) return;
      this.child = null;
      this.childConfig = null;
      this.clearSpawnPoll();
      this.setError('Could not start JOBS. Check the folder and Node.js installation.');
    });
    this.pollAfterSpawn(cfg, generation, 0);
  }

  private pollAfterSpawn(cfg: JobsSettings, generation: number, attempt: number): void {
    if (!this.current(generation) || !this.child) return;
    this.clearSpawnPoll();
    const child = this.child;
    this.spawnPollTimer = setTimeout(() => {
      this.spawnPollTimer = null;
      void this.probe(cfg.url).then(probe => {
        if (!this.current(generation) || this.child !== child) return;
        if (probe.ok) {
          this.setStatus({ ...this.status, detected: true, version: probe.version, managed: true, phase: 'connected', error: undefined });
        } else if (attempt + 1 >= SPAWN_POLL_MAX) {
          this.stopManagedChild();
          this.setError('JOBS launched but did not become ready. Check the port and server setup, then try again.');
        } else this.pollAfterSpawn(cfg, generation, attempt + 1);
      });
    }, SPAWN_POLL_MS);
  }

  private setError(error: string): void {
    this.setStatus({ ...this.status, detected: false, version: null, managed: !!this.child, phase: 'unavailable', error });
  }

  private setStatus(next: JobsStatus): void {
    if (this.disposed || JSON.stringify(this.status) === JSON.stringify(next)) return;
    this.status = next;
    for (const cb of this.listeners) {
      try { cb(this.getStatus()); } catch { /* Observers never break lifecycle handling. */ }
    }
  }

  private clearSpawnPoll(): void {
    if (this.spawnPollTimer) clearTimeout(this.spawnPollTimer);
    this.spawnPollTimer = null;
  }

  private stopManagedChild(): void {
    this.clearSpawnPoll();
    const child = this.child;
    this.child = null;
    this.childConfig = null;
    if (child) {
      const done = new Promise<void>(resolve => {
        const finish = () => {
          if (this.stopping?.child === child) this.stopping = null;
          child.removeListener('exit', finish);
          child.removeListener('error', finish);
          resolve();
        };
        child.once('exit', finish);
        child.once('error', finish);
      });
      this.stopping = { child, done };
      log.info('Stopping managed JOBS server');
      try { child.kill(); } catch { /* Already gone. */ }
    }
  }

  private async waitForStop(): Promise<boolean> {
    const stopping = this.stopping;
    if (!stopping) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        stopping.done.then(() => true),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.probeController.abort();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopManagedChild();
    this.listeners.clear();
  }
}

export const jobsService = new JobsService();
