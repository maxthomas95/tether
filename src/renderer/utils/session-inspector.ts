import type { EnvironmentInfo, SessionInfo, SessionUsage } from '../../shared/types';

export type CodexActivityPhase =
  | 'running'
  | 'permission'
  | 'compacting'
  | 'complete'
  | 'interrupted';

export interface CodexSessionActivity {
  lastHookAt: string | null;
  phase: CodexActivityPhase;
  activeSubagentIds: string[];
  compactionCount: number;
  observedModel?: string;
  modelObservedAt?: string;
}

export type InspectableSession = SessionInfo & {
  launchProfileName?: string;
  codexLaunch?: {
    model?: string;
    reasoningEffort?: string;
    profile?: string;
  };
  activity?: CodexSessionActivity;
};

export type HookHealthStatus = 'not-applicable' | 'disabled' | 'remote-unavailable' | 'no-events' | 'events';

export interface InspectorConfig {
  cliHooksEnabled: boolean;
  codexLifecycleHooksEnabled: boolean;
}

export interface InspectorViewModel {
  stripModel: string | null;
  costLabel: string;
  messageLabel: string;
  usageAvailable: boolean;
  hookHealth: HookHealthStatus;
  rows: Array<{ label: string; value: string; muted?: boolean }>;
}

export function shortenModel(model: string): string {
  return model.startsWith('claude-') ? model.slice('claude-'.length) : model;
}

export function formatCost(cost: number | null | undefined): string {
  if (cost === null || cost === undefined || !Number.isFinite(cost) || cost < 0) return 'Unknown';
  if (cost === 0) return '$0.00';
  if (cost < 0.01) return '<$0.01';
  if (cost >= 1000) return `$${(cost / 1000).toFixed(1)}k`;
  return `$${cost.toFixed(2)}`;
}

export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return 'Unknown';
  if (n === 0) return '0';
  if (n < 1000) return n.toString();
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function latestModel(usage: SessionUsage | null, session?: InspectableSession): string | null {
  const usageModel = usage?.currentModel ?? null;
  const activityModel = session?.activity?.observedModel ?? null;
  if (usageModel && activityModel && usage?.observedAt && session?.activity?.lastHookAt) {
    return timestampMs(session.activity.modelObservedAt ?? session.activity.lastHookAt) > timestampMs(usage.observedAt) ? activityModel : usageModel;
  }
  return usageModel ?? activityModel;
}

export function usageModel(usage: SessionUsage | null): string | null {
  if (!usage || usage.models.length === 0) return null;
  if (usage.models.length === 1) return usage.models[0].model;
  let best = usage.models[0];
  for (const model of usage.models) {
    if (model.cost > best.cost) best = model;
  }
  return best.model;
}

export function describeHookHealth(
  session: InspectableSession | undefined,
  environment: EnvironmentInfo | undefined,
  config: InspectorConfig,
): HookHealthStatus {
  const cliTool = session?.cliTool ?? 'claude';
  if (cliTool !== 'codex') return 'not-applicable';
  if (!config.cliHooksEnabled || !config.codexLifecycleHooksEnabled) return 'disabled';
  if (environment && environment.type !== 'local') return 'remote-unavailable';
  return session?.activity?.lastHookAt ? 'events' : 'no-events';
}

export function buildInspectorViewModel(args: {
  nativeSessionId?: string;
  tetherSessionId?: string | null;
  session?: InspectableSession;
  environment?: EnvironmentInfo;
  usage: SessionUsage | null;
  config: InspectorConfig;
}): InspectorViewModel {
  const { nativeSessionId, tetherSessionId, session, environment, usage, config } = args;
  const model = latestModel(usage, session);
  const usageAvailable = usage !== null;
  const messageCount = usage?.messageCount ?? null;
  const hookHealth = describeHookHealth(session, environment, config);
  const activity = session?.activity;
  const cliTool = session?.cliTool ?? usage?.cliTool ?? 'claude';
  const isCodex = cliTool === 'codex';
  const launchProfile = session?.launchProfileName ?? 'Default';
  const stripModel = isCodex ? model : usageModel(usage);
  const rows: InspectorViewModel['rows'] = [
    { label: 'Native ID', value: nativeSessionId ?? 'Unknown', muted: !nativeSessionId },
    { label: 'Tether ID', value: tetherSessionId ?? session?.id ?? 'Unknown', muted: !(tetherSessionId ?? session?.id) },
    { label: 'CLI', value: cliTool },
    { label: 'Project', value: session?.workingDir ?? 'Unknown', muted: !session?.workingDir },
    { label: 'Environment', value: environment ? `${environment.name} (${environment.type})` : session?.environmentId ? 'Unknown environment' : 'Local' },
    { label: 'Resumed', value: session?.resumed ? 'Yes' : 'No' },
    { label: 'Tether Launch Profile', value: launchProfile },
  ];

  if (isCodex) {
    rows.push(
      { label: 'Native Codex Profile', value: session?.codexLaunch?.profile ?? 'Unknown', muted: !session?.codexLaunch?.profile },
      { label: 'Requested Launch Model', value: session?.codexLaunch?.model ?? 'Unknown', muted: !session?.codexLaunch?.model },
      { label: 'Requested Launch Reasoning', value: session?.codexLaunch?.reasoningEffort ?? 'Unknown', muted: !session?.codexLaunch?.reasoningEffort },
      { label: 'Latest Observed Model', value: model ? shortenModel(model) : 'Unknown', muted: !model },
      { label: 'Observed Reasoning Effort', value: usage?.currentReasoningEffort ?? 'Unknown', muted: !usage?.currentReasoningEffort },
      { label: 'Last Request Size', value: `${formatTokens(usage?.contextUsedTokens)} tokens`, muted: usage?.contextUsedTokens === null || usage?.contextUsedTokens === undefined },
      { label: 'Context Note', value: 'Last reported request size; not live remaining context' },
      { label: 'Context Window', value: `${formatTokens(usage?.contextWindowTokens)} tokens`, muted: usage?.contextWindowTokens === null || usage?.contextWindowTokens === undefined },
      { label: 'Metadata Observed', value: formatTimestamp(usage?.observedAt), muted: !usage?.observedAt },
      { label: 'Activity Phase', value: activity?.phase ?? 'Unknown', muted: !activity?.phase },
      { label: 'Last Hook Event', value: formatTimestamp(activity?.lastHookAt), muted: !activity?.lastHookAt },
      { label: 'Active Subagents', value: activity ? String(activity.activeSubagentIds.length) : 'Unknown', muted: !activity },
      { label: 'Compactions', value: activity ? String(activity.compactionCount) : 'Unknown', muted: !activity },
      { label: 'Observed Activity Model', value: activity?.observedModel ? shortenModel(activity.observedModel) : 'Unknown', muted: !activity?.observedModel },
      { label: 'Hook Health', value: hookHealthLabel(hookHealth) },
    );
  } else {
    rows.push({ label: 'Usage Model', value: stripModel ? shortenModel(stripModel) : 'Unknown', muted: !stripModel });
  }

  rows.push(
    { label: 'Input Tokens', value: formatTokens(usage?.inputTokens), muted: usage?.inputTokens === null || usage?.inputTokens === undefined },
    { label: 'Output Tokens', value: formatTokens(usage?.outputTokens), muted: usage?.outputTokens === null || usage?.outputTokens === undefined },
    { label: 'Reasoning Tokens', value: formatTokens(usage?.reasoningTokens), muted: usage?.reasoningTokens === null || usage?.reasoningTokens === undefined },
    { label: 'Cache Created', value: formatTokens(usage?.cacheCreationTokens), muted: usage?.cacheCreationTokens === null || usage?.cacheCreationTokens === undefined },
    { label: 'Cache Read', value: formatTokens(usage?.cacheReadTokens), muted: usage?.cacheReadTokens === null || usage?.cacheReadTokens === undefined },
    { label: 'Usage Tracking', value: usageAvailable
      ? session?.remoteUsageStatus === 'unavailable' ? 'Last collected remote totals; retrying' : 'Available'
      : session?.remoteUsageStatus === 'pending' ? 'Waiting for remote usage' : usageAvailabilityLabel(environment), muted: !usageAvailable || session?.remoteUsageStatus === 'unavailable' },
  );

  return {
    stripModel: stripModel ? shortenModel(stripModel) : null,
    costLabel: usageAvailable ? formatCost(usage.totalCost) : 'Unknown',
    messageLabel: messageCount === null
      ? 'Unknown msgs'
      : `${messageCount} ${messageCount === 1 ? 'msg' : 'msgs'}`,
    usageAvailable,
    hookHealth,
    rows,
  };
}

export function hookHealthLabel(status: HookHealthStatus): string {
  switch (status) {
    case 'not-applicable':
      return 'Not applicable';
    case 'disabled':
      return 'Disabled by settings';
    case 'remote-unavailable':
      return 'Unavailable for remote sessions';
    case 'events':
      return 'Receiving events';
    case 'no-events':
      return 'No lifecycle events yet';
  }
}

function timestampMs(value: string): number {
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

function usageAvailabilityLabel(environment: EnvironmentInfo | undefined): string {
  if (environment && environment.type !== 'local') return 'Unavailable for remote metadata';
  return 'No local usage metadata yet';
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return 'Unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}
