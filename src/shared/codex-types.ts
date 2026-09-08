export interface CodexUsageSummary {
  lifetimeTokens: number | null;
  peakDailyTokens: number | null;
  longestRunningTurnSec: number | null;
  currentStreakDays: number | null;
  longestStreakDays: number | null;
}

export interface CodexDailyUsageBucket {
  date: string;
  tokens: number;
}

export interface CodexRateLimitWindow {
  usedPercent: number | null;
  windowMinutes: number | null;
  resetsAt: string | null;
}

export interface CodexRateLimit {
  id: string;
  name: string;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
}

export interface CodexAccountSnapshot {
  status: 'ready' | 'unavailable' | 'error';
  lastUpdated: string | null;
  error: string | null;
  authMode: string | null;
  planType: string | null;
  summary: CodexUsageSummary | null;
  dailyUsage: CodexDailyUsageBucket[];
  rateLimits: CodexRateLimit[];
  warnings: string[];
}

export interface CodexConfigurationField {
  key: string;
  value: string | null;
  source: string | null;
}

export interface CodexConfigurationProfile {
  name: string;
}

export interface CodexConfigurationModel {
  id: string;
  displayName: string;
  reasoningEfforts: string[];
  defaultReasoningEffort: string | null;
}

export interface CodexIntegration {
  name: string;
  kind: 'mcp' | 'skill';
  enabled: boolean | null;
}

export interface CodexConfigurationSnapshot {
  status: 'ready' | 'unavailable' | 'error';
  lastUpdated: string | null;
  error: string | null;
  fields: CodexConfigurationField[];
  profiles: CodexConfigurationProfile[];
  models: CodexConfigurationModel[];
  integrations: CodexIntegration[];
}
