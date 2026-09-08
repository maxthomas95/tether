import type { CliToolId, EnvironmentInfo, SessionInfo, SessionUsage, UsageInfo, UsageModelBreakdown } from '../../shared/types';

export type UsageDatePreset = 'today' | '7d' | '30d' | 'all' | 'custom';
export type UsageSortKey = 'lastActivity' | 'cost' | 'tokens' | 'messages' | 'session';
export type UsageSortDirection = 'asc' | 'desc';

export interface UsageExplorerFilters {
  cliTools: CliToolId[];
  projects: string[];
  environments: string[];
  models: string[];
  datePreset: UsageDatePreset;
  customStartDate: string;
  customEndDate: string;
}

export interface UsageExplorerOptions {
  usage: UsageInfo | null;
  sessions?: SessionInfo[];
  environments?: EnvironmentInfo[];
  filters: UsageExplorerFilters;
  sort: { key: UsageSortKey; direction: UsageSortDirection };
  today?: Date;
  allTimeChartDays?: number;
}

export interface UsageExplorerTotals {
  cost: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  messages: number | null;
  sessions: number;
}

export interface UsageExplorerComparison {
  available: boolean;
  label: string;
  totals: UsageExplorerTotals;
}

export interface UsageExplorerDailyRow extends UsageExplorerTotals {
  date: string;
  label: string;
  approximate: boolean;
}

export interface UsageExplorerModelRow extends UsageExplorerTotals {
  model: string;
}

export interface UsageExplorerSessionRow extends UsageExplorerTotals {
  sessionId: string;
  cliTool: CliToolId;
  cliLabel: string;
  label: string;
  project: string;
  environmentId: string | null;
  environmentLabel: string;
  currentModel: string | null;
  currentReasoningEffort: string | null;
  contextUsedTokens: number | null;
  contextWindowTokens: number | null;
  firstDate: string | null;
  lastDate: string | null;
  timing: 'event' | 'snapshot' | 'legacy';
  approximate: boolean;
  models: UsageExplorerModelRow[];
}

export interface UsageExplorerOption {
  value: string;
  label: string;
}

export interface UsageExplorerResult {
  dateRange: { startDate: string | null; endDate: string | null; finite: boolean; label: string; invalid: boolean; capped: boolean };
  totals: UsageExplorerTotals;
  comparison: UsageExplorerComparison;
  daily: UsageExplorerDailyRow[];
  sessions: UsageExplorerSessionRow[];
  options: {
    cliTools: Array<UsageExplorerOption & { value: CliToolId }>;
    projects: UsageExplorerOption[];
    environments: UsageExplorerOption[];
    models: UsageExplorerOption[];
  };
  includesUnknownDay: boolean;
}

interface DaySlice {
  sessionId: string;
  cliTool: CliToolId;
  environmentId: string | null;
  project: string;
  timing: 'event' | 'snapshot' | 'legacy';
  date: string | null;
  models: UsageModelBreakdown[];
  totals: UsageExplorerTotals;
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const EMPTY_TOTALS: UsageExplorerTotals = {
  cost: 0,
  tokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  reasoningTokens: 0,
  messages: 0,
  sessions: 0,
};

export function cacheReadRatio(inputTokens: number, cacheReadTokens: number, cacheCreationTokens: number): number | null {
  const denominator = inputTokens + cacheReadTokens + cacheCreationTokens;
  if (denominator === 0) return null;
  return cacheReadTokens / denominator;
}

function cloneTotals(): UsageExplorerTotals {
  return { ...EMPTY_TOTALS };
}

function addUTCDays(date: Date, days: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function utcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function parseISODate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return isoDate(parsed) === value ? parsed : null;
}

function formatDateLabel(value: string): string {
  const date = parseISODate(value);
  if (!date) return value;
  return `${SHORT_MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

function tokenTotal(parts: Pick<UsageExplorerTotals, 'inputTokens' | 'outputTokens' | 'cacheCreationTokens' | 'cacheReadTokens'>): number {
  return parts.inputTokens + parts.outputTokens + parts.cacheCreationTokens + parts.cacheReadTokens;
}

function totalsFromModels(models: ReadonlyArray<UsageModelBreakdown>, messages: number | null): UsageExplorerTotals {
  const totals = cloneTotals();
  for (const model of models) {
    totals.cost += model.cost;
    totals.inputTokens += model.inputTokens;
    totals.outputTokens += model.outputTokens;
    totals.cacheCreationTokens += model.cacheCreationTokens;
    totals.cacheReadTokens += model.cacheReadTokens;
    totals.reasoningTokens += model.reasoningTokens ?? 0;
  }
  totals.tokens = tokenTotal(totals);
  totals.messages = messages;
  return totals;
}

function totalsFromSession(session: SessionUsage): UsageExplorerTotals {
  const totals = cloneTotals();
  totals.cost = session.totalCost;
  totals.inputTokens = session.inputTokens;
  totals.outputTokens = session.outputTokens;
  totals.cacheCreationTokens = session.cacheCreationTokens;
  totals.cacheReadTokens = session.cacheReadTokens;
  totals.reasoningTokens = session.reasoningTokens ?? 0;
  totals.tokens = tokenTotal(totals);
  totals.messages = session.messageCount;
  return totals;
}

function totalsFromDay(day: NonNullable<SessionUsage['daily']>[number]): UsageExplorerTotals {
  const totals = cloneTotals();
  totals.cost = day.totalCost;
  totals.inputTokens = day.inputTokens;
  totals.outputTokens = day.outputTokens;
  totals.cacheCreationTokens = day.cacheCreationTokens;
  totals.cacheReadTokens = day.cacheReadTokens;
  totals.reasoningTokens = day.reasoningTokens ?? 0;
  totals.tokens = tokenTotal(totals);
  totals.messages = day.messageCount;
  return totals;
}

function addTotals(target: UsageExplorerTotals, source: UsageExplorerTotals): void {
  target.cost += source.cost;
  target.tokens += source.tokens;
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheCreationTokens += source.cacheCreationTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.reasoningTokens += source.reasoningTokens;
  target.messages = target.messages == null || source.messages == null
    ? null
    : target.messages + source.messages;
}

function modelRows(models: ReadonlyArray<UsageModelBreakdown>): UsageExplorerModelRow[] {
  const rows = new Map<string, UsageExplorerModelRow>();
  for (const model of models) {
    const row = rows.get(model.model) ?? { model: model.model, ...cloneTotals() };
    row.cost += model.cost;
    row.inputTokens += model.inputTokens;
    row.outputTokens += model.outputTokens;
    row.cacheCreationTokens += model.cacheCreationTokens;
    row.cacheReadTokens += model.cacheReadTokens;
    row.reasoningTokens += model.reasoningTokens ?? 0;
    rows.set(model.model, row);
  }
  for (const row of rows.values()) {
    row.tokens = tokenTotal(row);
    row.messages = null;
  }
  return Array.from(rows.values()).sort((a, b) => b.cost - a.cost || a.model.localeCompare(b.model));
}

function dateRangeFor(filters: UsageExplorerFilters, today: Date): UsageExplorerResult['dateRange'] {
  const end = utcDay(today);
  if (filters.datePreset === 'all') {
    return { startDate: null, endDate: null, finite: false, label: 'All time', invalid: false, capped: false };
  }
  if (filters.datePreset === 'custom') {
    const startDate = parseISODate(filters.customStartDate);
    const endDate = parseISODate(filters.customEndDate);
    if (!startDate || !endDate) return { startDate: null, endDate: null, finite: true, label: 'Invalid custom range', invalid: true, capped: false };
    const start = startDate <= endDate ? startDate : endDate;
    let finish = startDate <= endDate ? endDate : startDate;
    const days = Math.floor((finish.getTime() - start.getTime()) / 86_400_000) + 1;
    const capped = days > 366;
    if (capped) finish = addUTCDays(start, 365);
    return { startDate: isoDate(start), endDate: isoDate(finish), finite: true, label: `${isoDate(start)} to ${isoDate(finish)}`, invalid: false, capped };
  }
  const days = filters.datePreset === 'today' ? 1 : filters.datePreset === '7d' ? 7 : 30;
  const start = addUTCDays(end, -(days - 1));
  return { startDate: isoDate(start), endDate: isoDate(end), finite: true, label: filters.datePreset === 'today' ? 'Today' : `Last ${days} days`, invalid: false, capped: false };
}

function previousRange(range: UsageExplorerResult['dateRange']): UsageExplorerResult['dateRange'] | null {
  if (!range.finite || !range.startDate || !range.endDate) return null;
  const start = parseISODate(range.startDate);
  const end = parseISODate(range.endDate);
  if (!start || !end) return null;
  const days = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
  const previousEnd = addUTCDays(start, -1);
  const previousStart = addUTCDays(previousEnd, -(days - 1));
  return { startDate: isoDate(previousStart), endDate: isoDate(previousEnd), finite: true, label: `Previous ${days === 1 ? 'day' : `${days} days`}`, invalid: false, capped: false };
}

function inRange(date: string | null, range: UsageExplorerResult['dateRange']): boolean {
  if (!date) return !range.finite;
  if (!range.finite) return true;
  return !!range.startDate && !!range.endDate && date >= range.startDate && date <= range.endDate;
}

function sessionProject(session: SessionUsage): string {
  return session.workingDir?.trim() || 'Unknown project';
}

function snapshotDate(session: SessionUsage): string | null {
  if (session.dayTiming !== 'snapshot' || !session.lastMessageAt) return null;
  const parsed = new Date(session.lastMessageAt);
  if (Number.isNaN(parsed.getTime())) return null;
  return isoDate(utcDay(parsed));
}

function buildSlices(usage: UsageInfo | null): DaySlice[] {
  if (!usage) return [];
  const slices: DaySlice[] = [];
  for (const session of Object.values(usage.sessions)) {
    const project = sessionProject(session);
    const environmentId = session.environmentId ?? null;
    if (session.daily && session.daily.length > 0) {
      for (const day of session.daily) {
        slices.push({
          sessionId: session.sessionId,
          cliTool: session.cliTool,
          environmentId,
          project,
          timing: session.dayTiming ?? 'event',
          date: day.date,
          models: day.models,
          totals: totalsFromDay(day),
        });
      }
      continue;
    }
    slices.push({
      sessionId: session.sessionId,
      cliTool: session.cliTool,
      environmentId,
      project,
      timing: session.dayTiming ?? 'legacy',
      date: snapshotDate(session),
      models: session.models,
      totals: totalsFromSession(session),
    });
  }
  return slices;
}

function matchesBasicFilters(slice: DaySlice, filters: UsageExplorerFilters): boolean {
  if (filters.cliTools.length > 0 && !filters.cliTools.includes(slice.cliTool)) return false;
  if (filters.projects.length > 0 && !filters.projects.includes(slice.project)) return false;
  if (filters.environments.length > 0 && !filters.environments.includes(slice.environmentId ?? 'unattributed')) return false;
  return true;
}

function applyModelFilter(slice: DaySlice, filters: UsageExplorerFilters): DaySlice | null {
  if (filters.models.length === 0) return slice;
  const models = slice.models.filter(model => filters.models.includes(model.model));
  if (models.length === 0) return null;
  return {
    ...slice,
    models,
    totals: totalsFromModels(models, null),
  };
}

function filteredSlices(slices: ReadonlyArray<DaySlice>, filters: UsageExplorerFilters, range: UsageExplorerResult['dateRange']): DaySlice[] {
  if (range.invalid) return [];
  const out: DaySlice[] = [];
  for (const slice of slices) {
    if (!matchesBasicFilters(slice, filters)) continue;
    const modelFiltered = applyModelFilter(slice, filters);
    if (!modelFiltered || !inRange(modelFiltered.date, range)) continue;
    if (range.finite && modelFiltered.timing === 'legacy') continue;
    out.push(modelFiltered);
  }
  return out;
}

function summarize(slices: ReadonlyArray<DaySlice>): UsageExplorerTotals {
  const totals = cloneTotals();
  const sessionIds = new Set<string>();
  for (const slice of slices) {
    addTotals(totals, slice.totals);
    sessionIds.add(slice.sessionId);
  }
  totals.sessions = sessionIds.size;
  return totals;
}

function sessionCountForDate(slices: ReadonlyArray<DaySlice>, date: string): number {
  return new Set(slices.filter(slice => slice.date === date).map(slice => slice.sessionId)).size;
}

function emptyDailyRow(date: string): UsageExplorerDailyRow {
  return {
    date,
    label: formatDateLabel(date),
    approximate: false,
    ...cloneTotals(),
  };
}

function dailyRows(slices: ReadonlyArray<DaySlice>, range: UsageExplorerResult['dateRange'], allTimeChartDays: number, today: Date): UsageExplorerDailyRow[] {
  const byDate = new Map<string, UsageExplorerDailyRow>();
  for (const slice of slices) {
    if (!slice.date) continue;
    const date = slice.date;
    const row = byDate.get(date) ?? {
      date,
      label: formatDateLabel(date),
      approximate: false,
      ...cloneTotals(),
    };
    addTotals(row, slice.totals);
    row.approximate = row.approximate || slice.timing !== 'event';
    byDate.set(date, row);
  }
  for (const [date, row] of byDate) {
    row.sessions = sessionCountForDate(slices, date);
  }
  if (range.invalid) return [];
  if (range.finite && range.startDate && range.endDate) {
    const start = parseISODate(range.startDate);
    const end = parseISODate(range.endDate);
    if (!start || !end) return [];
    const rows: UsageExplorerDailyRow[] = [];
    for (let day = start; day <= end; day = addUTCDays(day, 1)) {
      const key = isoDate(day);
      rows.push(byDate.get(key) ?? emptyDailyRow(key));
    }
    return rows;
  }
  const chartEnd = utcDay(today);
  const chartStart = addUTCDays(chartEnd, -(allTimeChartDays - 1));
  const rows: UsageExplorerDailyRow[] = [];
  for (let day = chartStart; day <= chartEnd; day = addUTCDays(day, 1)) {
    const key = isoDate(day);
    rows.push(byDate.get(key) ?? emptyDailyRow(key));
  }
  return rows;
}

function sessionRows(
  slices: ReadonlyArray<DaySlice>,
  usage: UsageInfo | null,
  liveSessions: ReadonlyArray<SessionInfo>,
  environments: ReadonlyArray<EnvironmentInfo>,
  sort: UsageExplorerOptions['sort'],
): UsageExplorerSessionRow[] {
  const liveByToolId = new Map<string, SessionInfo>();
  for (const session of liveSessions) {
    if (session.toolSessionId) liveByToolId.set(session.toolSessionId, session);
    liveByToolId.set(session.id, session);
  }
  const envById = new Map(environments.map(env => [env.id, env]));
  const bySession = new Map<string, { slices: DaySlice[]; totals: UsageExplorerTotals; models: UsageModelBreakdown[] }>();
  for (const slice of slices) {
    const entry = bySession.get(slice.sessionId) ?? { slices: [], totals: cloneTotals(), models: [] };
    entry.slices.push(slice);
    entry.models.push(...slice.models);
    addTotals(entry.totals, slice.totals);
    bySession.set(slice.sessionId, entry);
  }
  const rows = Array.from(bySession.entries()).map(([sessionId, entry]) => {
    const source = usage?.sessions[sessionId];
    const firstSlice = entry.slices[0];
    const live = liveByToolId.get(sessionId);
    const dates = entry.slices.map(slice => slice.date).filter((date): date is string => !!date).sort();
    const environmentId = firstSlice.environmentId;
    const environment = environmentId ? envById.get(environmentId) : null;
    const cliTool = firstSlice.cliTool;
    return {
      sessionId,
      cliTool,
      cliLabel: cliTool,
      label: live?.label || source?.currentModel || sessionId,
      project: firstSlice.project,
      environmentId,
      environmentLabel: environment?.name ?? (environmentId ? environmentId : 'Unattributed'),
      currentModel: source?.currentModel ?? null,
      currentReasoningEffort: source?.currentReasoningEffort ?? null,
      contextUsedTokens: source?.contextUsedTokens ?? null,
      contextWindowTokens: source?.contextWindowTokens ?? null,
      firstDate: dates[0] ?? null,
      lastDate: dates[dates.length - 1] ?? null,
      timing: firstSlice.timing,
      approximate: entry.slices.some(slice => slice.timing !== 'event' || !slice.date),
      models: modelRows(entry.models),
      ...entry.totals,
      sessions: 1,
    };
  });
  rows.sort((a, b) => {
    const direction = sort.direction === 'asc' ? 1 : -1;
    if (sort.key === 'session') return direction * a.label.localeCompare(b.label);
    if (sort.key === 'cost') return direction * (a.cost - b.cost);
    if (sort.key === 'tokens') return direction * (a.tokens - b.tokens);
    if (sort.key === 'messages') return direction * ((a.messages ?? -1) - (b.messages ?? -1));
    return direction * ((a.lastDate ?? '').localeCompare(b.lastDate ?? ''));
  });
  return rows;
}

function optionsFrom(usage: UsageInfo | null, environments: ReadonlyArray<EnvironmentInfo>): UsageExplorerResult['options'] {
  const sessions = Object.values(usage?.sessions ?? {});
  const cliTools = Array.from(new Set(sessions.map(session => session.cliTool))).sort();
  const projects = Array.from(new Set(sessions.map(sessionProject))).sort();
  const models = Array.from(new Set(sessions.flatMap(session => [
    ...session.models.map(model => model.model),
    ...(session.daily ?? []).flatMap(day => day.models.map(model => model.model)),
  ]))).sort();
  const envIds = new Set(sessions.map(session => session.environmentId ?? 'unattributed'));
  return {
    cliTools: cliTools.map(value => ({ value, label: value })),
    projects: projects.map(value => ({ value, label: value })),
    environments: Array.from(envIds).sort().map(value => ({
      value,
      label: value === 'unattributed' ? 'Unattributed' : environments.find(env => env.id === value)?.name ?? value,
    })),
    models: models.map(value => ({ value, label: value })),
  };
}

export function createDefaultUsageExplorerFilters(today = new Date()): UsageExplorerFilters {
  const end = isoDate(utcDay(today));
  return {
    cliTools: [],
    projects: [],
    environments: [],
    models: [],
    datePreset: '30d',
    customStartDate: isoDate(addUTCDays(utcDay(today), -29)),
    customEndDate: end,
  };
}

export function buildUsageExplorer(options: UsageExplorerOptions): UsageExplorerResult {
  const today = options.today ?? new Date();
  const range = dateRangeFor(options.filters, today);
  const allSlices = buildSlices(options.usage);
  const currentSlices = filteredSlices(allSlices, options.filters, range);
  const previous = previousRange(range);
  const previousSlices = previous ? filteredSlices(allSlices, options.filters, previous) : [];
  const totals = summarize(currentSlices);
  return {
    dateRange: range,
    totals,
    comparison: {
      available: !!previous,
      label: previous?.label ?? 'Previous period',
      totals: summarize(previousSlices),
    },
    daily: dailyRows(currentSlices, range, options.allTimeChartDays ?? 30, today),
    sessions: sessionRows(currentSlices, options.usage, options.sessions ?? [], options.environments ?? [], options.sort),
    options: optionsFrom(options.usage, options.environments ?? []),
    includesUnknownDay: currentSlices.some(slice => !slice.date || slice.timing === 'legacy'),
  };
}
