import fs from 'node:fs';
import path from 'node:path';
import { getCodexHome } from './transcripts';
import { callCodexAppServer, type CodexAppServerCallResult } from './app-server-client';
import type {
  CodexAccountSnapshot,
  CodexConfigurationField,
  CodexConfigurationModel,
  CodexConfigurationSnapshot,
  CodexDailyUsageBucket,
  CodexIntegration,
  CodexRateLimit,
  CodexRateLimitWindow,
  CodexUsageSummary,
} from '../../shared/codex-types';

const CONFIG_KEYS = ['model', 'model_reasoning_effort', 'sandbox_mode', 'approval_policy', 'web_search', 'service_tier'] as const;

type JsonObject = Record<string, unknown>;

export async function readCodexAccount(): Promise<CodexAccountSnapshot> {
  const now = new Date().toISOString();
  const results = await callCodexAppServer([
    { method: 'account/read', params: { refreshToken: false } },
    { method: 'account/usage/read' },
    { method: 'account/rateLimits/read' },
  ]);

  if (results.every(result => !result.ok && result.unavailable)) {
    return accountSnapshot('unavailable', now, 'Codex app-server unavailable');
  }

  const account = resultFor(results, 'account/read');
  const usage = resultFor(results, 'account/usage/read');
  const rateLimits = resultFor(results, 'account/rateLimits/read');
  const warnings = warningsFor(results);

  if (!account.ok && !usage.ok && !rateLimits.ok) {
    return accountSnapshot('error', now, 'Codex account data could not be read', warnings);
  }

  const accountResult = asObject(account.result);
  const accountInfo = asObject(accountResult?.account);
  const authMode = stringOrNull(accountInfo?.type);
  const planType = stringOrNull(accountInfo?.planType) ?? planTypeFromRateLimits(rateLimits.result);
  const usageResult = asObject(usage.result);

  return {
    status: 'ready',
    lastUpdated: now,
    error: null,
    authMode,
    planType,
    summary: summaryFromUsage(usageResult),
    dailyUsage: dailyUsageFromUsage(usageResult),
    rateLimits: rateLimitsFromResponse(rateLimits.result),
    warnings,
  };
}

export async function readCodexQuota(): Promise<CodexAccountSnapshot> {
  const now = new Date().toISOString();
  const results = await callCodexAppServer([
    { method: 'account/read', params: { refreshToken: false } },
    { method: 'account/rateLimits/read' },
  ]);

  if (results.every(result => !result.ok && result.unavailable)) {
    return accountSnapshot('unavailable', now, 'Codex app-server unavailable');
  }

  const account = resultFor(results, 'account/read');
  const rateLimits = resultFor(results, 'account/rateLimits/read');
  const warnings = warningsFor(results);

  if (!account.ok && !rateLimits.ok) {
    return accountSnapshot('error', now, 'Codex quota could not be read', warnings);
  }

  const accountResult = asObject(account.result);
  const accountInfo = asObject(accountResult?.account);

  return {
    status: 'ready',
    lastUpdated: now,
    error: null,
    authMode: stringOrNull(accountInfo?.type),
    planType: stringOrNull(accountInfo?.planType) ?? planTypeFromRateLimits(rateLimits.result),
    summary: null,
    dailyUsage: [],
    rateLimits: rateLimitsFromResponse(rateLimits.result),
    warnings,
  };
}

export async function inspectCodexConfiguration(cwd?: string): Promise<CodexConfigurationSnapshot> {
  const now = new Date().toISOString();
  const results = await callCodexAppServer([
    { method: 'config/read', params: { includeLayers: true, cwd: cwd ?? null } },
    { method: 'model/list', params: { includeHidden: false, limit: 100, cursor: null } },
  ]);

  if (results.every(result => !result.ok && result.unavailable)) {
    return configurationSnapshot('unavailable', now, 'Codex app-server unavailable');
  }

  const config = resultFor(results, 'config/read');
  const models = resultFor(results, 'model/list');
  const warnings = warningsFor(results);
  if (!config.ok && !models.ok) {
    return configurationSnapshot('error', now, 'Codex configuration could not be read');
  }

  const configResult = asObject(config.result);
  const effectiveConfig = asObject(configResult?.config);

  return {
    status: 'ready',
    lastUpdated: now,
    error: warnings.length > 0 ? warnings.join('; ') : null,
    fields: fieldsFromConfig(configResult, effectiveConfig),
    profiles: readProfileNames(),
    models: modelsFromResponse(models.result),
    integrations: integrationsFromConfig(effectiveConfig),
  };
}

function accountSnapshot(
  status: CodexAccountSnapshot['status'],
  lastUpdated: string | null,
  error: string | null,
  warnings: string[] = [],
): CodexAccountSnapshot {
  return {
    status,
    lastUpdated,
    error,
    authMode: null,
    planType: null,
    summary: null,
    dailyUsage: [],
    rateLimits: [],
    warnings,
  };
}

function configurationSnapshot(
  status: CodexConfigurationSnapshot['status'],
  lastUpdated: string | null,
  error: string | null,
): CodexConfigurationSnapshot {
  return {
    status,
    lastUpdated,
    error,
    fields: [],
    profiles: [],
    models: [],
    integrations: [],
  };
}

function resultFor(results: CodexAppServerCallResult[], method: CodexAppServerCallResult['method']): CodexAppServerCallResult {
  return results.find(result => result.method === method) ?? { method, ok: false, error: 'Codex app-server request failed' };
}

function warningsFor(results: CodexAppServerCallResult[]): string[] {
  return results
    .filter(result => !result.ok)
    .map(result => `${result.method}: ${result.error ?? 'request failed'}`);
}

function summaryFromUsage(usage: JsonObject | null): CodexUsageSummary | null {
  const summary = asObject(usage?.summary);
  if (!summary) return null;
  return {
    lifetimeTokens: nullableNumber(summary.lifetimeTokens),
    peakDailyTokens: nullableNumber(summary.peakDailyTokens),
    longestRunningTurnSec: nullableNumber(summary.longestRunningTurnSec),
    currentStreakDays: nullableNumber(summary.currentStreakDays),
    longestStreakDays: nullableNumber(summary.longestStreakDays),
  };
}

function dailyUsageFromUsage(usage: JsonObject | null): CodexDailyUsageBucket[] {
  const buckets = Array.isArray(usage?.dailyUsageBuckets) ? usage.dailyUsageBuckets : [];
  return buckets.flatMap(bucket => {
    const row = asObject(bucket);
    const date = stringOrNull(row?.startDate);
    const tokens = numberOrNull(row?.tokens);
    if (!date || tokens === null || tokens < 0) return [];
    return [{ date, tokens }];
  });
}

function rateLimitsFromResponse(value: unknown): CodexRateLimit[] {
  const response = asObject(value);
  if (!response) return [];
  const byId = asObject(response.rateLimitsByLimitId);
  if (byId) {
    return Object.entries(byId).flatMap(([id, raw]) => rateLimitFromSnapshot(id, raw));
  }
  return rateLimitFromSnapshot('codex', response.rateLimits);
}

function rateLimitFromSnapshot(id: string, raw: unknown): CodexRateLimit[] {
  const snapshot = asObject(raw);
  if (!snapshot) return [];
  const name = stringOrNull(snapshot.limitName) ?? id;
  return [{
    id: stringOrNull(snapshot.limitId) ?? id,
    name,
    primary: rateLimitWindow(snapshot.primary),
    secondary: rateLimitWindow(snapshot.secondary),
  }];
}

function rateLimitWindow(raw: unknown): CodexRateLimitWindow | null {
  const window = asObject(raw);
  if (!window) return null;
  const resetsAt = numberOrNull(window.resetsAt);
  return {
    usedPercent: nullableNumber(window.usedPercent),
    windowMinutes: nullableNumber(window.windowDurationMins),
    resetsAt: resetsAt === null ? null : new Date(resetsAt * 1000).toISOString(),
  };
}

function planTypeFromRateLimits(value: unknown): string | null {
  const response = asObject(value);
  const rateLimits = asObject(response?.rateLimits);
  return stringOrNull(rateLimits?.planType);
}

function fieldsFromConfig(configResult: JsonObject | null, config: JsonObject | null): CodexConfigurationField[] {
  return CONFIG_KEYS.map(key => ({
    key,
    value: formatConfigValue(key, config?.[key]),
    source: sourceForKey(configResult, key),
  }));
}

function formatConfigValue(key: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (key === 'approval_policy' && typeof value === 'object') return 'Custom policy';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  return 'Configured';
}

function sourceForKey(configResult: JsonObject | null, key: string): string | null {
  const origins = asObject(configResult?.origins);
  const origin = asObject(origins?.[key]);
  const name = asObject(origin?.name);
  if (!name) return null;
  const type = stringOrNull(name.type);
  if (!type) return null;
  if (type === 'user') return name.profile ? `user:${String(name.profile)}` : 'user';
  if (type === 'project') return 'project';
  if (type === 'sessionFlags') return 'session flags';
  if (type === 'packagedDefaults') return 'packaged defaults';
  if (type === 'enterpriseManaged') return 'enterprise managed';
  if (type === 'system') return 'system';
  return type;
}

function readProfileNames(): { name: string }[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(getCodexHome(), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.config.toml'))
    .map(entry => ({ name: path.basename(entry.name, '.config.toml') }))
    .filter(profile => profile.name.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function modelsFromResponse(value: unknown): CodexConfigurationModel[] {
  const response = asObject(value);
  const rows = Array.isArray(response?.data) ? response.data : [];
  return rows.flatMap(row => {
    const model = asObject(row);
    const id = stringOrNull(model?.id);
    if (!id) return [];
    const efforts = Array.isArray(model?.supportedReasoningEfforts)
      ? model.supportedReasoningEfforts.flatMap(effort => {
        const option = asObject(effort);
        const value = stringOrNull(option?.reasoningEffort);
        return value ? [value] : [];
      })
      : [];
    return [{
      id,
      displayName: stringOrNull(model?.displayName) ?? id,
      reasoningEfforts: efforts,
      defaultReasoningEffort: stringOrNull(model?.defaultReasoningEffort),
    }];
  });
}

function integrationsFromConfig(config: JsonObject | null): CodexIntegration[] {
  const mcp = asObject(config?.mcp_servers) ?? asObject(config?.mcpServers);
  if (!mcp) return [];
  return Object.entries(mcp).map(([name, raw]) => {
    const cfg = asObject(raw);
    return {
      name,
      kind: 'mcp' as const,
      enabled: cfg && typeof cfg.enabled === 'boolean' ? cfg.enabled : null,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nullableNumber(value: unknown): number | null {
  const number = numberOrNull(value);
  return number === null || number < 0 ? null : number;
}
