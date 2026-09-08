import { describe, expect, it } from 'vitest';
import type { EnvironmentInfo, SessionUsage } from '../../shared/types';
import { buildInspectorViewModel, formatCost, formatTokens, latestModel, type InspectableSession } from './session-inspector';

const baseUsage: SessionUsage = {
  sessionId: 'native-1',
  cliTool: 'codex',
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  totalCost: 0,
  models: [{ model: 'gpt-5-old', inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 25 }],
  currentModel: null,
  currentReasoningEffort: null,
  contextUsedTokens: null,
  contextWindowTokens: null,
  observedAt: null,
  messageCount: 0,
  firstMessageAt: null,
  lastMessageAt: null,
  parsedByteOffset: 0,
};

const localEnv: EnvironmentInfo = {
  id: 'local',
  name: 'Local PC',
  type: 'local',
  config: {},
  envVars: {},
  sessionCount: 1,
};

const session: InspectableSession = {
  id: 'tether-1',
  environmentId: null,
  cliTool: 'codex',
  label: 'Codex',
  workingDir: 'C:\\repo\\tether',
  state: 'running',
  createdAt: '2026-09-07T00:00:00.000Z',
};

describe('session inspector formatting', () => {
  it('keeps unknown values distinct from zero values', () => {
    expect(formatCost(undefined)).toBe('Unknown');
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(Number.NaN)).toBe('Unknown');
    expect(formatCost(-1)).toBe('Unknown');
    expect(formatTokens(null)).toBe('Unknown');
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe('Unknown');
    expect(formatTokens(-1)).toBe('Unknown');
  });

  it('uses the latest reported model before lifetime model breakdowns', () => {
    expect(latestModel({ ...baseUsage, currentModel: 'gpt-5-current' }, session)).toBe('gpt-5-current');
    expect(latestModel(baseUsage, { ...session, activity: {
      phase: 'running',
      lastHookAt: '2026-09-07T12:00:00.000Z',
      activeSubagentIds: [],
      compactionCount: 0,
      observedModel: 'gpt-5-observed',
    } })).toBe('gpt-5-observed');
  });

  it('does not treat requested launch model as latest observed model', () => {
    expect(latestModel(null, { ...session, codexLaunch: { model: 'gpt-5-requested' } })).toBeNull();

    const vm = buildInspectorViewModel({
      nativeSessionId: 'native-1',
      tetherSessionId: 'tether-1',
      session: { ...session, codexLaunch: { model: 'gpt-5-requested', reasoningEffort: 'high', profile: 'nightly' } },
      environment: localEnv,
      usage: null,
      config: { cliHooksEnabled: true, codexLifecycleHooksEnabled: true },
    });

    expect(vm.rows).toContainEqual({ label: 'Requested Launch Model', value: 'gpt-5-requested', muted: false });
    expect(vm.rows).toContainEqual({ label: 'Latest Observed Model', value: 'Unknown', muted: true });
    expect(vm.rows).toContainEqual({ label: 'Observed Reasoning Effort', value: 'Unknown', muted: true });
  });

  it('chooses the newer observed model when transcript and hook observations differ', () => {
    const observedSession: InspectableSession = {
      ...session,
      activity: {
        phase: 'running',
        lastHookAt: '2026-09-07T12:05:00.000Z',
        activeSubagentIds: [],
        compactionCount: 0,
        observedModel: 'gpt-5-hook',
      },
    };

    expect(latestModel({
      ...baseUsage,
      currentModel: 'gpt-5-transcript',
      observedAt: '2026-09-07T12:00:00.000Z',
    }, observedSession)).toBe('gpt-5-hook');

    expect(latestModel({
      ...baseUsage,
      currentModel: 'gpt-5-transcript',
      observedAt: '2026-09-07T12:10:00.000Z',
    }, observedSession)).toBe('gpt-5-transcript');
  });

  it('labels contextUsedTokens as last request size', () => {
    const vm = buildInspectorViewModel({
      nativeSessionId: 'native-1',
      tetherSessionId: 'tether-1',
      session,
      environment: localEnv,
      usage: { ...baseUsage, contextUsedTokens: 1234, contextWindowTokens: 200000 },
      config: { cliHooksEnabled: true, codexLifecycleHooksEnabled: true },
    });

    expect(vm.rows).toContainEqual({ label: 'Last Request Size', value: '1.2k tokens', muted: false });
    expect(vm.rows).toContainEqual({ label: 'Context Note', value: 'Last reported request size; not live remaining context' });
    expect(vm.rows).toContainEqual({ label: 'Context Window', value: '200.0k tokens', muted: false });
  });

  it('defaults Codex lifecycle hook health off unless the setting is explicitly true', () => {
    const vm = buildInspectorViewModel({
      nativeSessionId: 'native-1',
      tetherSessionId: 'tether-1',
      session,
      environment: localEnv,
      usage: baseUsage,
      config: { cliHooksEnabled: true, codexLifecycleHooksEnabled: false },
    });

    expect(vm.rows).toContainEqual({ label: 'Hook Health', value: 'Disabled by settings' });
  });

  it('keeps non-Codex strip model coverage without Codex hook clutter', () => {
    const claudeUsage: SessionUsage = {
      ...baseUsage,
      cliTool: 'claude',
      currentModel: null,
      models: [
        { model: 'claude-sonnet-4-5', inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0.25 },
      ],
    };
    const vm = buildInspectorViewModel({
      nativeSessionId: 'claude-native',
      tetherSessionId: 'tether-1',
      session: { ...session, cliTool: 'claude' },
      environment: localEnv,
      usage: claudeUsage,
      config: { cliHooksEnabled: false, codexLifecycleHooksEnabled: false },
    });

    expect(vm.stripModel).toBe('sonnet-4-5');
    expect(vm.rows).toContainEqual({ label: 'Usage Model', value: 'sonnet-4-5', muted: false });
    expect(vm.rows.some(row => row.label === 'Hook Health')).toBe(false);
    expect(vm.rows.some(row => row.label === 'Latest Observed Model')).toBe(false);
  });

  it('marks remote missing usage metadata as unavailable instead of zero', () => {
    const vm = buildInspectorViewModel({
      nativeSessionId: undefined,
      tetherSessionId: 'tether-1',
      session,
      environment: { ...localEnv, type: 'ssh', name: 'VM' },
      usage: null,
      config: { cliHooksEnabled: true, codexLifecycleHooksEnabled: true },
    });

    expect(vm.costLabel).toBe('Unknown');
    expect(vm.messageLabel).toBe('Unknown msgs');
    expect(vm.rows).toContainEqual({ label: 'Usage Tracking', value: 'Unavailable for remote metadata', muted: true });
    expect(vm.rows).toContainEqual({ label: 'Hook Health', value: 'Unavailable for remote sessions' });
  });
});
