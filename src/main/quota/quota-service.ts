import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createLogger } from '../logger';
import type { QuotaInfo, CodexQuota } from '../../shared/types';

const log = createLogger('quota');

const POLL_INTERVAL_MS = 300_000; // 5 minutes
const TOKEN_REFRESH_BUFFER_MS = 300_000; // refresh if <5 min until expiry
const CLAUDE_API_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_TOKEN_REFRESH_URL = 'https://platform.claude.com/v1/oauth/token';
const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');

const CODEX_API_URL = 'https://chatgpt.com/backend-api/wham/usage';
const CODEX_AUTH_PATH = path.join(os.homedir(), '.codex', 'auth.json');

interface ClaudeCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  subscriptionType?: string;
  rateLimitTier?: string;
}

interface CodexCredentials {
  accessToken: string;
  accountId?: string;
}

interface ClaudeApiResponse {
  five_hour?: { utilization: number; resets_at: string | null };
  seven_day?: { utilization: number; resets_at: string | null };
  [key: string]: unknown;
}

interface CodexApiResponse {
  rate_limit?: {
    primary_window?: { used_percent: number; reset_at: string | null };
    secondary_window?: { used_percent: number; reset_at: string | null };
  };
  plan_type?: string;
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
    codex: null,
  };
}

class QuotaService {
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private lastQuota: QuotaInfo = emptyQuota();
  private callback: ((info: QuotaInfo) => void) | null = null;
  private _enabled = true;

  get enabled(): boolean { return this._enabled; }

  setEnabled(enabled: boolean): void {
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
    if (!this._enabled) return;
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
    if (!this._enabled) return this.lastQuota;

    // Fetch Claude and Codex in parallel
    const [claudeResult, codexResult] = await Promise.all([
      this.fetchClaude(),
      this.fetchCodex(),
    ]);

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
    const creds = this.readCodexCredentials();
    if (!creds) return null; // No Codex installed / not logged in — just skip

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);

      const headers: Record<string, string> = {
        'Authorization': `Bearer ${creds.accessToken}`,
        'Accept': 'application/json',
      };
      if (creds.accountId) {
        headers['ChatGPT-Account-Id'] = creds.accountId;
      }

      const res = await fetch(CODEX_API_URL, { headers, signal: controller.signal });
      clearTimeout(timeout);

      if (res.status === 401 || res.status === 403) {
        return {
          primary: { usedPercent: null, resetAt: null },
          secondary: { usedPercent: null, resetAt: null },
          planType: null,
          error: "Codex credentials expired — run 'codex' to refresh",
        };
      }

      if (!res.ok) {
        return {
          primary: this.lastQuota.codex?.primary ?? { usedPercent: null, resetAt: null },
          secondary: this.lastQuota.codex?.secondary ?? { usedPercent: null, resetAt: null },
          planType: this.lastQuota.codex?.planType ?? null,
          error: `Codex API error: ${res.status}`,
        };
      }

      const data: CodexApiResponse = await res.json();

      return {
        primary: {
          usedPercent: data.rate_limit?.primary_window?.used_percent ?? null,
          resetAt: data.rate_limit?.primary_window?.reset_at ?? null,
        },
        secondary: {
          usedPercent: data.rate_limit?.secondary_window?.used_percent ?? null,
          resetAt: data.rate_limit?.secondary_window?.reset_at ?? null,
        },
        planType: data.plan_type ?? null,
        error: null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('Codex quota fetch failed', { error: message });
      return {
        primary: this.lastQuota.codex?.primary ?? { usedPercent: null, resetAt: null },
        secondary: this.lastQuota.codex?.secondary ?? { usedPercent: null, resetAt: null },
        planType: this.lastQuota.codex?.planType ?? null,
        error: message.includes('abort') ? 'Codex: request timed out' : `Codex: ${message}`,
      };
    }
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

  private readCodexCredentials(): CodexCredentials | null {
    try {
      const raw = fs.readFileSync(CODEX_AUTH_PATH, 'utf-8');
      const json = JSON.parse(raw);
      const token = json?.tokens?.access_token;
      if (!token) return null;
      return {
        accessToken: token,
        accountId: json?.tokens?.account_id,
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
