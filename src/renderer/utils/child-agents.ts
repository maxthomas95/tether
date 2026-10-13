import type { ChildAgentInfo, ChildAgentTokens } from '../../shared/child-agents';
import type { EnvironmentInfo, SessionInfo } from '../../shared/types';
import { formatTokens, shortenModel } from './session-inspector';

/** Rows shown before "+N more". */
export const CHILD_AGENT_ROW_LIMIT = 20;

/** Local Claude sessions are the only ones whose subagent files Tether can read. */
export function supportsChildAgents(
  session: SessionInfo,
  environmentById: ReadonlyMap<string, EnvironmentInfo>,
): boolean {
  if ((session.cliTool ?? 'claude') !== 'claude') return false;
  if (!session.claudeSessionId && !session.toolSessionId) return false;
  return !session.environmentId || environmentById.get(session.environmentId)?.type === 'local';
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function ms(iso: string): number {
  const value = Date.parse(iso);
  return Number.isNaN(value) ? 0 : value;
}

/** "running 2m" while it works, "done 41s" (its own working time) once finished. */
export function formatChildAgentTiming(agent: ChildAgentInfo, now: number): string {
  if (agent.state === 'running') return `running ${formatElapsed(now - ms(agent.startedAt))}`;
  return `done ${formatElapsed(ms(agent.lastActivityAt) - ms(agent.startedAt))}`;
}

/**
 * New work only: cache reads are re-counted on every turn and would swamp the
 * figure. The tooltip carries the full breakdown.
 */
export function childAgentTokenTotal(tokens: ChildAgentTokens): number {
  return tokens.input + tokens.output + tokens.cacheWrite;
}

export function formatChildAgentTokens(tokens: ChildAgentTokens): string {
  return `${formatTokens(childAgentTokenTotal(tokens))} tok`;
}

export function describeChildAgentTokens(tokens: ChildAgentTokens): string {
  return `Input ${formatTokens(tokens.input)}, output ${formatTokens(tokens.output)}, `
    + `cache written ${formatTokens(tokens.cacheWrite)}, cache read ${formatTokens(tokens.cacheRead)}`;
}

/** Resolved model first (what ran), then the requested one, then nothing. */
export function formatChildAgentModel(agent: ChildAgentInfo): string {
  const model = agent.model ?? agent.requestedModel;
  if (!model) return agent.effort ?? '';
  const short = shortenModel(model);
  return agent.effort ? `${short}/${agent.effort}` : short;
}

export function childAgentSummary(agent: ChildAgentInfo, now: number): string {
  const parts = [agent.agentType];
  if (agent.description) parts.push(agent.description);
  const model = formatChildAgentModel(agent);
  if (model) parts.push(model);
  parts.push(formatChildAgentTiming(agent, now), formatChildAgentTokens(agent.tokens));
  return parts.join(' · ');
}

/**
 * Keep the list to `limit` rows by dropping the oldest finished agents first,
 * so a running agent is never hidden behind "+N more".
 */
export function selectVisibleChildAgents(
  agents: readonly ChildAgentInfo[],
  limit: number,
  showAll: boolean,
): { visible: ChildAgentInfo[]; hidden: number } {
  if (showAll || agents.length <= limit) return { visible: [...agents], hidden: 0 };
  const drop = new Set<string>();
  let excess = agents.length - limit;
  for (const agent of agents) {
    if (excess === 0) break;
    if (agent.state === 'done') { drop.add(agent.id); excess--; }
  }
  const visible = agents.filter(a => !drop.has(a.id));
  return { visible, hidden: agents.length - visible.length };
}
