import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createLogger } from '../logger';
import type { QuotaInfo } from '../../shared/types';

const log = createLogger('quota');

const POLL_INTERVAL_MS = 300_000; // 5 minutes
const TOKEN_REFRESH_BUFFER_MS = 300_000; // refresh if <5 min until expiry
const API_URL = 'https://api.anthropic.com/api/oauth/usage';
const TOKEN_REFRESH_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');

interface ClaudeCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  subscriptionType?: string;
  rateLimitTier?: string;
}

interface ApiUsageResponse {
  five_hour?: { utilization: number; resets_at: string | null };
  seven_day?: { utilization: number; resets_at: string | null };
  [key: string]: unknown;
}

function emptyQuota(error: string | null = null): QuotaInfo {
  return {
    fiveHour: { utilization: null, resetsAt: null },
    sevenDay: { utilization: null, resetsAt: null },
    subscriptionType: null,
    rateLimitTier: null,
    lastUpdated: null,
    error,
  };
}

class QuotaService {
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private lastQuota: QuotaInfo = emptyQuota();
  private callback: ((info: QuotaInfo) => void) | null = null;

  onUpdate(cb: (info: QuotaInfo) => void): void {
    this.callback = cb;
  }

  start(): void {
    log.info('Quota polling started');
    this.fetchQuota();
    this.pollInterval = setInterval(() => this.fetchQuota(), POLL_INTERVAL_MS);
  }

  stop(): void {
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
    const creds = this.readCredentials();
    if (!creds) {
      const info = emptyQuota('No Claude credentials found');
      this.update(info);
      return info;
    }

    try {
      let token = creds.accessToken;

      // Refresh token if close to expiry
      if (creds.expiresAt - Date.now() < TOKEN_REFRESH_BUFFER_MS) {
        try {
          token = await this.refreshToken(creds.refreshToken);
        } catch (err) {
          log.warn('Token refresh failed', { error: err instanceof Error ? err.message : String(err) });
          // Try with existing token anyway — it may still work
        }
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);

      const res = await fetch(API_URL, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
          'anthropic-beta': 'oauth-2025-04-20',
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.status === 401 || res.status === 403) {
        const info = emptyQuota("Claude credentials expired — run 'claude login' to refresh");
        info.subscriptionType = creds.subscriptionType ?? null;
        info.rateLimitTier = creds.rateLimitTier ?? null;
        this.update(info);
        return info;
      }

      if (!res.ok) {
        const info: QuotaInfo = {
          ...this.lastQuota,
          error: `API error: ${res.status}`,
          lastUpdated: this.lastQuota.lastUpdated,
        };
        this.update(info);
        return info;
      }

      const data: ApiUsageResponse = await res.json();

      const info: QuotaInfo = {
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

      this.update(info);
      return info;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('Quota fetch failed', { error: message });

      const info: QuotaInfo = {
        ...this.lastQuota,
        error: message.includes('abort') ? 'Request timed out' : `Network error: ${message}`,
      };
      this.update(info);
      return info;
    }
  }

  private readCredentials(): ClaudeCredentials | null {
    try {
      const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
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

  private async refreshToken(refreshToken: string): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    });

    const res = await fetch(TOKEN_REFRESH_URL, {
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
      const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
      const json = JSON.parse(raw);
      json.claudeAiOauth.accessToken = newToken;
      json.claudeAiOauth.expiresAt = newExpiry;
      if (data.refresh_token) {
        json.claudeAiOauth.refreshToken = data.refresh_token;
      }
      const tmpPath = CREDENTIALS_PATH + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(json, null, 2), 'utf-8');
      fs.renameSync(tmpPath, CREDENTIALS_PATH);
      log.info('Refreshed OAuth token');
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
