import type { UsageInfo, SessionUsage } from '../../shared/types';

const CSV_COLUMNS = [
  'sessionId',
  'cliTool',
  'workingDir',
  'firstMessageAt',
  'lastMessageAt',
  'messageCount',
  'inputTokens',
  'outputTokens',
  'cacheCreationTokens',
  'cacheReadTokens',
  'totalCost',
] as const;

/**
 * RFC 4180 quoting: wrap in double quotes, double any embedded quotes, and
 * always quote when the value contains comma, quote, CR, or LF. Plain numeric
 * and short text values pass through unwrapped to keep the CSV readable.
 */
function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'string' ? value : String(value);
  if (s.length === 0) return '';
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function csvRow(values: ReadonlyArray<string | number | null | undefined>): string {
  return values.map(csvField).join(',');
}

function sessionToCsvValues(s: SessionUsage & { workingDir: string }): Array<string | number | null> {
  return [
    s.sessionId,
    s.cliTool,
    s.workingDir ?? '',
    s.firstMessageAt,
    s.lastMessageAt,
    s.messageCount,
    s.inputTokens,
    s.outputTokens,
    s.cacheCreationTokens,
    s.cacheReadTokens,
    s.totalCost,
  ];
}

/**
 * Serialize per-session usage as RFC 4180 CSV. One row per session with
 * totals; the full model breakdown is only available in the JSON export.
 * `workingDir` is included on the SessionUsage by the exporter wrapper —
 * the in-memory shape doesn't carry it, so the caller must enrich.
 */
export function serializeUsageCsv(sessions: ReadonlyArray<SessionUsage & { workingDir: string }>): string {
  const lines: string[] = [csvRow(CSV_COLUMNS)];
  // Stable order: most-recent activity first, then sessionId for ties.
  const sorted = [...sessions].sort((a, b) => {
    const at = a.lastMessageAt ?? '';
    const bt = b.lastMessageAt ?? '';
    if (at !== bt) return bt.localeCompare(at);
    return a.sessionId.localeCompare(b.sessionId);
  });
  for (const s of sorted) {
    lines.push(csvRow(sessionToCsvValues(s)));
  }
  return lines.join('\r\n') + '\r\n';
}

export interface UsageJsonExport {
  exportedAt: string;
  tetherVersion: string;
  totalCost: number;
  lastUpdated: string | null;
  sessions: Array<SessionUsage & { workingDir: string }>;
  daily: UsageInfo['daily'];
}

export function serializeUsageJson(
  usage: UsageInfo,
  sessions: ReadonlyArray<SessionUsage & { workingDir: string }>,
  tetherVersion: string,
): string {
  const payload: UsageJsonExport = {
    exportedAt: new Date().toISOString(),
    tetherVersion,
    totalCost: usage.totalCost,
    lastUpdated: usage.lastUpdated,
    sessions: [...sessions],
    daily: usage.daily,
  };
  return JSON.stringify(payload, null, 2);
}
