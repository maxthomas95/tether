import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createLogger } from '../logger';
import type { QuotaInfo, CodexQuota, ScopedQuotaWindow } from '../../shared/types';
import { readCodexQuota } from '../codex/integration-service';

const log = createLogger('quota');

const POLL_INTERVAL_MS = 300_000; // 5 minutes
const CLAUDE_API_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');


interface ClaudeCredentials {
  accessToken: string;
  expiresAt: number;
  subscriptionType?: string;
  rateLimitTier?: string;
}

interface ClaudeApiResponse {
  five_hour?: { utilization: number; resets_at: string | null };
  seven_day?: { utilization: number; resets_at: string | null };
  limits?: unknown;
  [key: string]: unknown;
}

interface ClaudeApiLimit {
  kind?: unknown;
  percent?: unknown;
  resets_at?: unknown;
  scope?: { model?: { display_name?: unknown } | null } | null;
}

/**
 * Extract model-scoped weekly limits (e.g. Fable) from the usage endpoint's
 * `limits` array. Unknown or malformed entries are skipped.
 */
export function parseScopedClaudeLimits(limits: unknown): ScopedQuotaWindow[] {
  if (!Array.isArray(limits)) return [];
  const windows: ScopedQuotaWindow[] = [];
  for (const entry of limits as ClaudeApiLimit[]) {
    if (!entry || typeof entry !== 'object' || entry.kind !== 'weekly_scoped') continue;
    const name = entry.scope?.model?.display_name;
    if (typeof name !== 'string' || !name.trim()) continue;
    if (typeof entry.percent !== 'number' || !Number.isFinite(entry.percent)) continue;
    windows.push({
      label: name.trim(),
      utilization: entry.percent,
      resetsAt: typeof entry.resets_at === 'string' ? entry.resets_at : null,
    });
  }
  return windows;
}

export function normalizeCodexResetAt(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const millis = value < 10_000_000_000 ? value * 1000 : value;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return normalizeCodexResetAt(Number(trimmed));
  }

  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function emptyQuota(error: string | null = null): QuotaInfo {
  return {
    fiveHour: { utilization: null, resetsAt: null },
    sevenDay: { utilization: null, resetsAt: null },
    scoped: [],
    subscriptionType: null,
    rateLimitTier: null,
    lastUpdated: null,
    error,
    codex: null,
  };
}

export class QuotaService {
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private lastQuota: QuotaInfo = emptyQuota();
  private callback: ((info: QuotaInfo) => void) | null = null;
  private _enabled = true;
  private generation = 0;
  private inflight: Promise<QuotaInfo> | null = null;
  private claudeRejectedToken: string | null = null;
  private claudeRejectedAttempts = 0;
  private claudeRejectedUntil = 0;

  get enabled(): boolean { return this._enabled; }

  setEnabled(enabled: boolean): void {
    if (this._enabled === enabled) return;
    this._enabled = enabled;
    if (!enabled) {
      this.stop();
      this.lastQuota = emptyQuota();
      this.callback?.(this.lastQuota);
    } else if (!this.pollInterval) {
      this.start();
    }
  }

  onUpdate(cb: (info: QuotaInfo) => void): void {
    this.callback = cb;
  }

  start(): void {
    if (!this._enabled || this.pollInterval) return;
    log.info('Quota polling started');
    const refresh = () => {
      void this.fetchQuota().catch(() => log.warn('Background quota refresh failed'));
    };
    refresh();
    this.pollInterval = setInterval(refresh, POLL_INTERVAL_MS);
  }

  stop(): void {
    this.generation++;
    this.inflight = null;
    this.resetClaudeRejectionBackoff();
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
      log.info('Quota polling stopped');
    }
  }

  getQuota(): QuotaInfo {
    return this.lastQuota;
  }

  async fetchQuota(): Promise<QuotaInfo> {
    if (!this._enabled) return this.lastQuota;
    if (this.inflight) return this.inflight;
    const generation = this.generation;
    const request = this.collectQuota(generation).finally(() => {
      if (this.inflight === request) this.inflight = null;
    });
    this.inflight = request;
    return request;
  }

  private async collectQuota(generation: number): Promise<QuotaInfo> {

    // Fetch Claude and Codex in parallel
    const [claudeResult, codexResult] = await Promise.all([
      this.fetchClaude(),
      this.fetchCodex(),
    ]);
    if (!this._enabled || generation !== this.generation) return this.lastQuota;

    const info: QuotaInfo = {
      ...claudeResult,
      codex: codexResult,
    };

    this.update(info);
    return info;
  }

  private async fetchClaude(): Promise<Omit<QuotaInfo, 'codex'>> {
    const creds = this.readClaudeCredentials();
    if (!creds) {
      return { ...emptyQuota('No Claude credentials found') };
    }

    if (creds.expiresAt > 0 && creds.expiresAt <= Date.now()) {
      return this.pausedClaudeQuota(
        creds,
        'Claude quota paused: the saved sign-in has expired. It resumes after Claude Code next refreshes it.',
      );
    }

    if (this.claudeRejectedToken !== null && this.claudeRejectedToken !== creds.accessToken) {
      this.resetClaudeRejectionBackoff();
    }

    const rejectedError = 'Claude sign-in was rejected. Open a Claude Code session to sign in again.';
    if (this.claudeRejectedToken === creds.accessToken && Date.now() < this.claudeRejectedUntil) {
      return this.pausedClaudeQuota(creds, rejectedError);
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);

      const res = await fetch(CLAUDE_API_URL, {
        headers: {
          'Authorization': `Bearer ${creds.accessToken}`,
          'Accept': 'application/json',
          'anthropic-beta': 'oauth-2025-04-20',
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.status === 401 || res.status === 403) {
        this.recordClaudeRejection(creds.accessToken);
        return this.pausedClaudeQuota(creds, rejectedError);
      }

      if (!res.ok) {
        return {
          fiveHour: this.lastQuota.fiveHour,
          sevenDay: this.lastQuota.sevenDay,
          scoped: this.lastQuota.scoped,
          subscriptionType: creds.subscriptionType ?? null,
          rateLimitTier: creds.rateLimitTier ?? null,
          lastUpdated: this.lastQuota.lastUpdated,
          error: `Claude API error: ${res.status}`,
        };
      }

      const data: ClaudeApiResponse = await res.json();
      this.resetClaudeRejectionBackoff();

      return {
        fiveHour: {
          utilization: data.five_hour?.utilization ?? null,
          resetsAt: data.five_hour?.resets_at ?? null,
        },
        sevenDay: {
          utilization: data.seven_day?.utilization ?? null,
          resetsAt: data.seven_day?.resets_at ?? null,
        },
        scoped: parseScopedClaudeLimits(data.limits),
        subscriptionType: creds.subscriptionType ?? null,
        rateLimitTier: creds.rateLimitTier ?? null,
        lastUpdated: new Date().toISOString(),
        error: null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('Claude quota fetch failed', { error: message });
      return {
        fiveHour: this.lastQuota.fiveHour,
        sevenDay: this.lastQuota.sevenDay,
        scoped: this.lastQuota.scoped,
        subscriptionType: this.lastQuota.subscriptionType,
        rateLimitTier: this.lastQuota.rateLimitTier,
        lastUpdated: this.lastQuota.lastUpdated,
        error: message.includes('abort') ? 'Claude: request timed out' : `Claude: ${message}`,
      };
    }
  }

  private async fetchCodex(): Promise<CodexQuota | null> {
    const snapshot = await readCodexQuota().catch(() => null);
    const previous = this.lastQuota.codex;
    if (snapshot?.status === 'unavailable' && !previous) return null;
    if (!snapshot || snapshot.status !== 'ready') {
      return {
        primary: previous?.primary ?? { usedPercent: null, resetAt: null },
        secondary: previous?.secondary ?? { usedPercent: null, resetAt: null },
        planType: previous?.planType ?? null,
        buckets: previous?.buckets ?? [],
        lastUpdated: previous?.lastUpdated ?? null,
        error: snapshot?.error || 'Codex quota is unavailable. Open Codex to check your sign-in.',
      };
    }
    const main = snapshot.rateLimits.find(bucket => bucket.id === 'codex') ?? snapshot.rateLimits[0];
    return {
      primary: { usedPercent: main?.primary?.usedPercent ?? null, resetAt: main?.primary?.resetsAt ?? null },
      secondary: { usedPercent: main?.secondary?.usedPercent ?? null, resetAt: main?.secondary?.resetsAt ?? null },
      buckets: snapshot.rateLimits,
      lastUpdated: snapshot.lastUpdated,
      planType: snapshot.planType,
      error: snapshot.warnings.length ? snapshot.warnings.join(' ') : null,
    };
  }

  private readClaudeCredentials(): ClaudeCredentials | null {
    try {
      const raw = fs.readFileSync(CLAUDE_CREDENTIALS_PATH, 'utf-8');
      const json = JSON.parse(raw);
      const oauth = json?.claudeAiOauth;
      if (!oauth?.accessToken) return null;
      return {
        accessToken: oauth.accessToken,
        expiresAt: oauth.expiresAt ?? 0,
        subscriptionType: oauth.subscriptionType,
        rateLimitTier: oauth.rateLimitTier,
      };
    } catch {
      return null;
    }
  }

  private pausedClaudeQuota(creds: ClaudeCredentials, error: string): Omit<QuotaInfo, 'codex'> {
    return {
      fiveHour: this.lastQuota.fiveHour,
      sevenDay: this.lastQuota.sevenDay,
      scoped: this.lastQuota.scoped,
      subscriptionType: creds.subscriptionType ?? null,
      rateLimitTier: creds.rateLimitTier ?? null,
      lastUpdated: this.lastQuota.lastUpdated,
      error,
    };
  }

  private recordClaudeRejection(accessToken: string): void {
    if (this.claudeRejectedToken !== accessToken) {
      this.claudeRejectedToken = accessToken;
      this.claudeRejectedAttempts = 0;
    }
    this.claudeRejectedAttempts++;
    const delay = Math.min(300_000 * 2 ** (this.claudeRejectedAttempts - 1), 3_600_000);
    this.claudeRejectedUntil = Date.now() + delay;
  }

  private resetClaudeRejectionBackoff(): void {
    this.claudeRejectedToken = null;
    this.claudeRejectedAttempts = 0;
    this.claudeRejectedUntil = 0;
  }

  private update(info: QuotaInfo): void {
    this.lastQuota = info;
    this.callback?.(info);
  }

  dispose(): void {
    this.stop();
  }
}

export const quotaService = new QuotaService();
