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
const MAX_ROWS = 400;
const MAX_STRING_LENGTH = 160;
const ALLOWED_SOURCE_TYPES = new Set(['user', 'project', 'sessionFlags', 'packagedDefaults', 'enterpriseManaged', 'system']);

type JsonObject = Record<string, unknown>;

export async function readCodexAccount(): Promise<CodexAccountSnapshot> {
  const now = new Date().toISOString();
  const results = await callCodexAppServer([
    { method: 'account/read', params: { refreshToken: false } },
    { method: 'account/usage/read' },
    { method: 'account/rateLimits/read' },
  ]);

  if (results.every(result => !result.ok && result.unavailable)) {
    return accountSnapshot('unavailable', null, 'Codex app-server unavailable');
  }

  const account = resultFor(results, 'account/read');
  const usage = resultFor(results, 'account/usage/read');
  const rateLimits = resultFor(results, 'account/rateLimits/read');
  const warnings = warningsFor(results);

  if (!account.ok && !usage.ok && !rateLimits.ok) {
    return accountSnapshot('error', null, 'Codex account data could not be read', warnings);
  }

  const accountResult = asObject(account.result);
  const accountInfo = asObject(accountResult?.account);
  const authMode = safeString(accountInfo?.type);
  const planType = safeString(accountInfo?.planType) ?? planTypeFromRateLimits(rateLimits.result);
  const usageResult = usage.ok ? asObject(usage.result) : null;
  const summary = summaryFromUsage(usageResult);
  if (usage.ok && summary === null) {
    warnings.push('account/usage/read: Codex app-server sent an invalid response');
  }

  return {
    status: 'ready',
    lastUpdated: now,
    error: null,
    authMode,
    planType,
    summary,
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
    return accountSnapshot('unavailable', null, 'Codex app-server unavailable');
  }

  const account = resultFor(results, 'account/read');
  const rateLimits = resultFor(results, 'account/rateLimits/read');
  const warnings = warningsFor(results);

  if (!rateLimits.ok) {
    return accountSnapshot('error', null, 'Codex quota could not be read', warnings);
  }

  const accountResult = asObject(account.result);
  const accountInfo = asObject(accountResult?.account);

  return {
    status: 'ready',
    lastUpdated: now,
    error: null,
    authMode: safeString(accountInfo?.type),
    planType: safeString(accountInfo?.planType) ?? planTypeFromRateLimits(rateLimits.result),
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
    return configurationSnapshot('unavailable', null, 'Codex app-server unavailable');
  }

  const config = resultFor(results, 'config/read');
  const models = resultFor(results, 'model/list');
  const warnings = warningsFor(results);
  if (!config.ok && !models.ok) {
    return configurationSnapshot('error', null, 'Codex configuration could not be read');
  }

  const configResult = config.ok ? asObject(config.result) : null;
  const effectiveConfig = asObject(configResult?.config);
  const configAvailable = config.ok && configResult !== null && effectiveConfig !== null;
  const configWarnings = [...warnings];
  if (config.ok && !configAvailable) {
    configWarnings.push('config/read: Codex app-server sent an invalid response');
  }

  return {
    status: 'ready',
    lastUpdated: now,
    error: configWarnings.length > 0 ? configWarnings.join('; ') : null,
    fields: configAvailable ? fieldsFromConfig(configResult, effectiveConfig) : [],
    profiles: readProfileNames(),
    models: modelsFromResponse(models.result),
    integrations: configAvailable ? integrationsFromConfig(effectiveConfig) : [],
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
  const byDate = new Map<string, number>();
  for (const bucket of buckets) {
    const row = asObject(bucket);
    const date = stringOrNull(row?.startDate);
    const tokens = numberOrNull(row?.tokens);
    if (!date || !validDateOnly(date) || tokens === null || !validCounter(tokens)) continue;
    byDate.set(date, (byDate.get(date) ?? 0) + tokens);
  }
  return Array.from(byDate.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, MAX_ROWS)
    .map(([date, tokens]) => ({ date, tokens }));
}

function rateLimitsFromResponse(value: unknown): CodexRateLimit[] {
  const response = asObject(value);
  if (!response) return [];
  const byId = asObject(response.rateLimitsByLimitId);
  if (byId) {
    return Object.entries(byId).flatMap(([id, raw]) => rateLimitFromSnapshot(safeString(id) ?? 'codex', raw)).slice(0, MAX_ROWS);
  }
  return rateLimitFromSnapshot('codex', response.rateLimits);
}

function rateLimitFromSnapshot(id: string, raw: unknown): CodexRateLimit[] {
  const snapshot = asObject(raw);
  if (!snapshot) return [];
  const name = safeString(snapshot.limitName) ?? id;
  const limitId = safeString(snapshot.limitId) ?? id;
  return [{
    id: limitId,
    name,
    primary: rateLimitWindow(snapshot.primary),
    secondary: rateLimitWindow(snapshot.secondary),
  }];
}

function rateLimitWindow(raw: unknown): CodexRateLimitWindow | null {
  const window = asObject(raw);
  if (!window) return null;
  const resetsAt = validTimestampSeconds(window.resetsAt);
  return {
    usedPercent: validPercent(window.usedPercent),
    windowMinutes: validCounterOrNull(window.windowDurationMins),
    resetsAt: resetsAt === null ? null : new Date(resetsAt * 1000).toISOString(),
  };
}

function planTypeFromRateLimits(value: unknown): string | null {
  const response = asObject(value);
  const rateLimits = asObject(response?.rateLimits);
  return safeString(rateLimits?.planType);
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
  if (typeof value === 'string') return safeString(value);
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  return 'Configured';
}

function sourceForKey(configResult: JsonObject | null, key: string): string | null {
  const origins = asObject(configResult?.origins);
  const origin = asObject(origins?.[key]);
  const name = asObject(origin?.name);
  if (!name) return null;
  const type = stringOrNull(name.type);
  if (!type || !ALLOWED_SOURCE_TYPES.has(type)) return null;
  if (type === 'user') return 'user';
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
    .filter(profile => profile.name.length > 0 && profile.name.length <= MAX_STRING_LENGTH)
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_ROWS);
}

function modelsFromResponse(value: unknown): CodexConfigurationModel[] {
  const response = asObject(value);
  const rows = Array.isArray(response?.data) ? response.data : [];
  return rows.flatMap(row => {
    const model = asObject(row);
    const id = safeString(model?.model) ?? safeString(model?.id);
    if (!id) return [];
    const efforts = Array.isArray(model?.supportedReasoningEfforts)
      ? model.supportedReasoningEfforts.flatMap(effort => {
        const option = asObject(effort);
        const value = safeString(option?.reasoningEffort);
        return value ? [value] : [];
      }).slice(0, 20)
      : [];
    return [{
      id,
      displayName: safeString(model?.displayName) ?? id,
      reasoningEfforts: efforts,
      defaultReasoningEffort: safeString(model?.defaultReasoningEffort),
    }];
  }).slice(0, MAX_ROWS);
}

function integrationsFromConfig(config: JsonObject | null): CodexIntegration[] {
  const mcp = asObject(config?.mcp_servers) ?? asObject(config?.mcpServers);
  if (!mcp) return [];
  return Object.entries(mcp).flatMap(([name, raw]) => {
    const safeName = safeString(name);
    if (!safeName) return [];
    const cfg = asObject(raw);
    return [{
      name: safeName,
      kind: 'mcp' as const,
      enabled: cfg && typeof cfg.enabled === 'boolean' ? cfg.enabled : null,
    }];
  }).sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_ROWS);
}

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function safeString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > MAX_STRING_LENGTH ? trimmed.slice(0, MAX_STRING_LENGTH) : trimmed;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nullableNumber(value: unknown): number | null {
  const number = numberOrNull(value);
  return number !== null && validCounter(number) ? number : null;
}

function validCounter(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validCounterOrNull(value: unknown): number | null {
  const number = numberOrNull(value);
  return number !== null && validCounter(number) ? number : null;
}

function validPercent(value: unknown): number | null {
  const number = numberOrNull(value);
  return number !== null && number >= 0 && number <= 100 ? number : null;
}

function validTimestampSeconds(value: unknown): number | null {
  const number = validCounterOrNull(value);
  if (number === null) return null;
  const millis = number * 1000;
  return Number.isFinite(millis) && !Number.isNaN(new Date(millis).getTime()) ? number : null;
}

function validDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
