import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../db/database';
import { createLogger } from '../logger';
import type { JobsEnabledMode, JobsStatus } from '../../shared/types';

const log = createLogger('jobs');

export const JOBS_DEFAULT_URL = 'http://localhost:8780';
const PROBE_INTERVAL_MS = 60_000;
const PROBE_TIMEOUT_MS = 3_000;
/** After spawning the server, poll healthz this often until it answers. */
const SPAWN_POLL_MS = 1_000;
const SPAWN_POLL_MAX = 15;

export interface JobsConfig {
  enabled: JobsEnabledMode;
  url: string;
  /** Bearer token sent on webhook posts; also injected as JOBS_TOKEN/WEBHOOK_TOKEN when Tether launches the server. */
  token?: string;
  /** Local JOBS checkout to auto-launch when no instance answers the probe. */
  path?: string;
}

/** Read the jobs* keys from the flat string config. Single source of truth for defaults. */
export function readJobsConfig(): JobsConfig {
  const cfg = getDb().config;
  return {
    enabled: cfg.jobsEnabled === 'off' ? 'off' : 'auto',
    url: (cfg.jobsUrl || JOBS_DEFAULT_URL).replace(/\/+$/, ''),
    token: cfg.jobsToken || undefined,
    path: cfg.jobsPath || undefined,
  };
}

function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  } catch {
    return false;
  }
}

/**
 * Probes for a running J.O.B.S. office server and optionally launches one from
 * a configured local checkout. Detection is positive-identification only: the
 * probe requires `healthz` to answer `{ app: "jobs" }` so a stranger service
 * on the same port never lights up the Office UI.
 *
 * Ownership rule: if Tether spawned the server, Tether kills it on quit. An
 * instance that was already running (Docker, user-started) is never touched.
 */
class JobsService {
  private status: JobsStatus = {
    enabled: 'auto',
    url: JOBS_DEFAULT_URL,
    detected: false,
    version: null,
    managed: false,
  };
  private child: ChildProcess | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private spawnPollTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<(status: JobsStatus) => void>();
  /** One launch attempt per config generation — reset by refresh(). */
  private launchAttempted = false;
  private disposed = false;

  getStatus(): JobsStatus {
    return { ...this.status };
  }

  onStatusChange(cb: (status: JobsStatus) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.tick(), PROBE_INTERVAL_MS);
  }

  /** Re-read config and probe immediately. Called after the Settings dialog saves. */
  async refresh(): Promise<JobsStatus> {
    this.launchAttempted = false;
    await this.tick();
    return this.getStatus();
  }

  private async tick(): Promise<void> {
    if (this.disposed) return;
    const cfg = readJobsConfig();

    if (cfg.enabled === 'off') {
      this.stopManagedChild();
      this.setStatus({ enabled: 'off', url: cfg.url, detected: false, version: null, managed: false });
      return;
    }

    const probe = await this.probe(cfg.url);
    if (probe) {
      this.setStatus({
        enabled: cfg.enabled,
        url: cfg.url,
        detected: true,
        version: probe.version,
        managed: this.child !== null,
      });
      return;
    }

    // Nothing answered. If we own a child that's still booting, let the spawn
    // poll handle it; otherwise consider launching from the configured path.
    if (!this.child && cfg.path && !this.launchAttempted) {
      this.launchAttempted = true;
      this.tryLaunch(cfg);
      return;
    }

    if (!this.child) {
      this.setStatus({ enabled: cfg.enabled, url: cfg.url, detected: false, version: null, managed: false, error: this.status.error });
    }
  }

  private async probe(url: string): Promise<{ version: string | null } | null> {
    try {
      const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      if (!res.ok) return null;
      const body = (await res.json()) as { app?: unknown; version?: unknown };
      if (body.app !== 'jobs') return null;
      return { version: typeof body.version === 'string' ? body.version : null };
    } catch {
      return null;
    }
  }

  private tryLaunch(cfg: JobsConfig): void {
    if (!cfg.path) return;
    if (!isLoopbackUrl(cfg.url)) {
      this.setError(cfg, 'Auto-launch skipped: JOBS URL is not localhost');
      return;
    }
    const entry = path.join(cfg.path, 'dist-server', 'server', 'index.js');
    if (!fs.existsSync(entry)) {
      this.setError(cfg, 'JOBS folder is not built — run "npm install && npm run build" in it first');
      log.warn('JOBS launch skipped: dist-server missing', { path: cfg.path });
      return;
    }

    let port = '8780';
    try {
      port = new URL(cfg.url).port || '8780';
    } catch { /* keep default */ }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // Run the server with Tether's own binary so a Node install isn't required.
      ELECTRON_RUN_AS_NODE: '1',
      PORT: port,
    };
    if (cfg.token) {
      env.JOBS_TOKEN = cfg.token;
      env.WEBHOOK_TOKEN = cfg.token;
    }

    log.info('Launching JOBS server', { entry, port });
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [entry], {
        cwd: cfg.path,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.setError(cfg, `Failed to launch JOBS: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.child = child;

    child.stdout?.on('data', (chunk: Buffer) => {
      const line = chunk.toString('utf-8').trim();
      if (line) log.info('[jobs-server] ' + line);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString('utf-8').trim();
      if (line) log.warn('[jobs-server] ' + line);
    });
    child.on('exit', (code) => {
      log.info('JOBS server exited', { code });
      if (this.child === child) {
        this.child = null;
        if (!this.disposed) {
          this.setStatus({ ...this.status, detected: false, managed: false, error: code ? `JOBS server exited with code ${code}` : undefined });
        }
      }
    });
    child.on('error', (err) => {
      log.warn('JOBS server spawn error', { error: err.message });
      if (this.child === child) {
        this.child = null;
        this.setError(cfg, `Failed to launch JOBS: ${err.message}`);
      }
    });

    this.pollAfterSpawn(cfg, 0);
  }

  private pollAfterSpawn(cfg: JobsConfig, attempt: number): void {
    if (this.disposed || !this.child) return;
    this.spawnPollTimer = setTimeout(() => {
      void this.probe(cfg.url).then((probe) => {
        if (this.disposed) return;
        if (probe) {
          log.info('JOBS server is up', { url: cfg.url, version: probe.version });
          this.setStatus({ enabled: cfg.enabled, url: cfg.url, detected: true, version: probe.version, managed: true });
          return;
        }
        if (attempt + 1 >= SPAWN_POLL_MAX) {
          log.warn('JOBS server did not answer healthz after launch — giving up', { url: cfg.url });
          this.stopManagedChild();
          this.setError(cfg, 'JOBS server launched but never answered healthz');
          return;
        }
        this.pollAfterSpawn(cfg, attempt + 1);
      });
    }, SPAWN_POLL_MS);
  }

  private setError(cfg: JobsConfig, error: string): void {
    this.setStatus({ enabled: cfg.enabled, url: cfg.url, detected: false, version: null, managed: false, error });
  }

  private setStatus(next: JobsStatus): void {
    const prev = this.status;
    this.status = next;
    const changed =
      prev.enabled !== next.enabled ||
      prev.url !== next.url ||
      prev.detected !== next.detected ||
      prev.version !== next.version ||
      prev.managed !== next.managed ||
      prev.error !== next.error;
    if (!changed) return;
    for (const cb of this.listeners) {
      try { cb(this.getStatus()); } catch { /* listeners never break the service */ }
    }
  }

  private stopManagedChild(): void {
    if (this.spawnPollTimer) {
      clearTimeout(this.spawnPollTimer);
      this.spawnPollTimer = null;
    }
    if (this.child) {
      log.info('Stopping managed JOBS server');
      try { this.child.kill(); } catch { /* already gone */ }
      this.child = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.stopManagedChild();
    this.listeners.clear();
  }
}

export const jobsService = new JobsService();
