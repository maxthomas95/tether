import { describe, expect, it } from 'vitest';
import type { ChildAgentInfo, ChildAgentList } from '../../shared/child-agents';
import type { EnvironmentInfo, SessionInfo } from '../../shared/types';
import {
  childAgentKind,
  childAgentSummary,
  childAgentsHeading,
  childAgentTokenTotal,
  formatChildAgentModel,
  formatChildAgentTiming,
  formatChildAgentTokens,
  formatElapsed,
  selectVisibleChildAgents,
  supportsChildAgents,
} from './child-agents';

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const iso = (secondsAfter: number) => new Date(T0 + secondsAfter * 1000).toISOString();

function agent(over: Partial<ChildAgentInfo> = {}): ChildAgentInfo {
  return {
    source: 'claude-subagent', id: 'a1', agentType: 'tester', description: 'Check things', background: false, depth: 1,
    state: 'done', startedAt: iso(0), lastActivityAt: iso(41), tokens: { input: 5, output: 1200, cacheRead: 90000, cacheWrite: 300 },
    ...over,
  };
}

describe('formatElapsed', () => {
  it.each([
    [0, '0s'], [41_000, '41s'], [59_999, '59s'], [60_000, '1m'], [125_000, '2m'],
    [3_600_000, '1h'], [3_900_000, '1h 5m'], [-5_000, '0s'],
  ])('%i ms is %s', (value, expected) => expect(formatElapsed(value)).toBe(expected));
});

describe('child agent labels', () => {
  it('counts up from the start while running and shows working time once done', () => {
    expect(formatChildAgentTiming(agent({ state: 'running' }), T0 + 125_000)).toBe('running 2m');
    expect(formatChildAgentTiming(agent(), T0 + 999_000)).toBe('done 41s');
  });

  it('prefers the model that ran, then the requested one, and appends effort', () => {
    expect(formatChildAgentModel(agent({ model: 'claude-sonnet-5-5', requestedModel: 'sonnet', effort: 'medium' }))).toBe('sonnet-5-5/medium');
    expect(formatChildAgentModel(agent({ requestedModel: 'sonnet' }))).toBe('sonnet');
    expect(formatChildAgentModel(agent({ effort: 'high' }))).toBe('high');
    expect(formatChildAgentModel(agent())).toBe('');
  });

  it('totals new work, leaving out cache reads that repeat every turn', () => {
    const tokens = agent().tokens;
    expect(childAgentTokenTotal(tokens)).toBe(1505);
    expect(formatChildAgentTokens(tokens)).toBe('1.5k tok');
  });

  it('builds one line with every field in order', () => {
    expect(childAgentSummary(agent({ model: 'claude-x', effort: 'low' }), T0)).toBe('tester · Check things · x/low · done 41s · 1.5k tok');
    expect(childAgentSummary(agent({ description: '' }), T0)).toBe('tester · done 41s · 1.5k tok');
  });
});

describe('supportsChildAgents', () => {
  const session = (over: Partial<SessionInfo> = {}): SessionInfo => ({
    id: 's1', environmentId: null, label: 'l', workingDir: '/w', state: 'running', createdAt: iso(0), claudeSessionId: 'c1', ...over,
  });
  const envs = new Map<string, EnvironmentInfo>([
    ['local-1', { id: 'local-1', type: 'local' } as EnvironmentInfo],
    ['ssh-1', { id: 'ssh-1', type: 'ssh' } as EnvironmentInfo],
    ['coder-1', { id: 'coder-1', type: 'coder' } as EnvironmentInfo],
  ]);

  it('accepts local, SSH and Coder Claude sessions with a known Claude id', () => {
    expect(supportsChildAgents(session(), envs)).toBe(true);
    expect(supportsChildAgents(session({ environmentId: 'local-1' }), envs)).toBe(true);
    expect(supportsChildAgents(session({ environmentId: 'ssh-1' }), envs)).toBe(true);
    expect(supportsChildAgents(session({ environmentId: 'coder-1' }), envs)).toBe(true);
    expect(supportsChildAgents(session({ claudeSessionId: undefined, toolSessionId: 't1' }), envs)).toBe(true);
  });

  it('rejects unknown environments, other CLIs, and sessions with no id yet', () => {
    expect(supportsChildAgents(session({ environmentId: 'unknown' }), envs)).toBe(false);
    expect(supportsChildAgents(session({ environmentId: 'ssh-1', cliTool: 'codex' }), envs)).toBe(false);
    expect(supportsChildAgents(session({ environmentId: 'ssh-1', claudeSessionId: undefined }), envs)).toBe(false);
    expect(supportsChildAgents(session({ cliTool: 'codex' }), envs)).toBe(false);
    expect(supportsChildAgents(session({ claudeSessionId: undefined }), envs)).toBe(false);
  });
});

describe('selectVisibleChildAgents', () => {
  const many = (count: number, runningIds: string[] = []) =>
    Array.from({ length: count }, (_, i) => agent({ id: `n${i}`, state: runningIds.includes(`n${i}`) ? 'running' : 'done' }));

  it('shows everything at or under the limit', () => {
    expect(selectVisibleChildAgents(many(20), 20, false)).toMatchObject({ hidden: 0 });
    expect(selectVisibleChildAgents(many(20), 20, false).visible).toHaveLength(20);
  });

  it('drops the oldest finished agents first, keeps running ones, and preserves order', () => {
    const { visible, hidden } = selectVisibleChildAgents(many(25, ['n0', 'n3']), 20, false);
    expect(hidden).toBe(5);
    expect(visible).toHaveLength(20);
    expect(visible.map(a => a.id).slice(0, 3)).toEqual(['n0', 'n3', 'n7']);
    expect(visible.at(-1)?.id).toBe('n24');
  });

  it('never hides a running agent even when that exceeds the limit', () => {
    const ids = Array.from({ length: 25 }, (_, i) => `n${i}`);
    const { visible, hidden } = selectVisibleChildAgents(many(25, ids), 20, false);
    expect(visible).toHaveLength(25);
    expect(hidden).toBe(0);
  });

  it('shows all when asked', () => {
    expect(selectVisibleChildAgents(many(30), 20, true)).toMatchObject({ hidden: 0 });
  });
});

describe('codex exec rows', () => {
  const exec = (over: Partial<ChildAgentInfo> = {}) => agent({
    source: 'codex-exec', id: 'thread-1', agentType: 'codex exec', description: 'Review the module', model: 'gpt-test', effort: 'high', ...over,
  });
  const list = (agents: ChildAgentInfo[], total = agents.length): ChildAgentList => ({ agents, total });

  it('reads as "codex exec · prompt · model/effort · state · tokens"', () => {
    expect(childAgentSummary(exec({ state: 'running' }), T0 + 125_000)).toBe('codex exec · Review the module · gpt-test/high · running 2m · 1.5k tok');
    expect(childAgentSummary(exec({ description: '', model: undefined, effort: undefined }), T0 + 999_000)).toBe('codex exec · done 41s · 1.5k tok');
  });

  it('names the kind of row for screen readers', () => {
    expect(childAgentKind(exec())).toBe('Codex exec run');
    expect(childAgentKind(agent())).toBe('Subagent');
  });

  it('words the heading for subagents, exec runs, and a mix', () => {
    expect(childAgentsHeading(list([agent()]))).toBe('1 subagent');
    expect(childAgentsHeading(list([agent(), agent({ id: 'a2' })]))).toBe('2 subagents');
    expect(childAgentsHeading(list([exec()]))).toBe('1 codex exec run');
    expect(childAgentsHeading(list([exec(), exec({ id: 't2' })]))).toBe('2 codex exec runs');
    expect(childAgentsHeading(list([agent(), exec()]))).toBe('2 child agents');
    expect(childAgentsHeading(list([exec()], 3))).toBe('3 child agents');
  });
});
