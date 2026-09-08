import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createLogger } from '../logger';
import type { QuotaInfo, CodexQuota } from '../../shared/types';
import { readCodexQuota } from '../codex/integration-service';

const log = createLogger('quota');

const POLL_INTERVAL_MS = 300_000; // 5 minutes
const TOKEN_REFRESH_BUFFER_MS = 300_000; // refresh if <5 min until expiry
const CLAUDE_API_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_TOKEN_REFRESH_URL = 'https://platform.claude.com/v1/oauth/token';
const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');


interface ClaudeCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  subscriptionType?: string;
  rateLimitTier?: string;
}

interface ClaudeApiResponse {
  five_hour?: { utilization: number; resets_at: string | null };
  seven_day?: { utilization: number; resets_at: string | null };
  [key: string]: unknown;
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
    this.fetchQuota();
    this.pollInterval = setInterval(() => this.fetchQuota(), POLL_INTERVAL_MS);
  }

  stop(): void {
    this.generation++;
    this.inflight = null;
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

    try {
      let token = creds.accessToken;

      // Refresh token if close to expiry
      if (creds.expiresAt - Date.now() < TOKEN_REFRESH_BUFFER_MS) {
        try {
          token = await this.refreshClaudeToken(creds.refreshToken);
        } catch (err) {
          log.warn('Claude token refresh failed', { error: err instanceof Error ? err.message : String(err) });
        }
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);

      const res = await fetch(CLAUDE_API_URL, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
          'anthropic-beta': 'oauth-2025-04-20',
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.status === 401 || res.status === 403) {
        return {
          ...emptyQuota("Claude credentials expired — run 'claude login' to refresh"),
          subscriptionType: creds.subscriptionType ?? null,
          rateLimitTier: creds.rateLimitTier ?? null,
        };
      }

      if (!res.ok) {
        return {
          fiveHour: this.lastQuota.fiveHour,
          sevenDay: this.lastQuota.sevenDay,
          subscriptionType: creds.subscriptionType ?? null,
          rateLimitTier: creds.rateLimitTier ?? null,
          lastUpdated: this.lastQuota.lastUpdated,
          error: `Claude API error: ${res.status}`,
        };
      }

      const data: ClaudeApiResponse = await res.json();

      return {
        fiveHour: {
          utilization: data.five_hour?.utilization ?? null,
          resetsAt: data.five_hour?.resets_at ?? null,
        },
        sevenDay: {
          utilization: data.seven_day?.utilization ?? null,
          resetsAt: data.seven_day?.resets_at ?? null,
        },
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
        refreshToken: oauth.refreshToken,
        expiresAt: oauth.expiresAt ?? 0,
        subscriptionType: oauth.subscriptionType,
        rateLimitTier: oauth.rateLimitTier,
      };
    } catch {
      return null;
    }
  }

  private async refreshClaudeToken(refreshToken: string): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLAUDE_CLIENT_ID,
    });

    const res = await fetch(CLAUDE_TOKEN_REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      throw new Error(`Token refresh failed: ${res.status}`);
    }

    const data = await res.json();
    const newToken = data.access_token as string;
    const newExpiry = Date.now() + ((data.expires_in as number) ?? 3600) * 1000;

    // Write updated credentials back
    try {
      const raw = fs.readFileSync(CLAUDE_CREDENTIALS_PATH, 'utf-8');
      const json = JSON.parse(raw);
      json.claudeAiOauth.accessToken = newToken;
      json.claudeAiOauth.expiresAt = newExpiry;
      if (data.refresh_token) {
        json.claudeAiOauth.refreshToken = data.refresh_token;
      }
      const tmpPath = CLAUDE_CREDENTIALS_PATH + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(json, null, 2), 'utf-8');
      fs.renameSync(tmpPath, CLAUDE_CREDENTIALS_PATH);
      log.info('Refreshed Claude OAuth token');
    } catch (err) {
      log.warn('Failed to write refreshed token', { error: err instanceof Error ? err.message : String(err) });
    }

    return newToken;
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
