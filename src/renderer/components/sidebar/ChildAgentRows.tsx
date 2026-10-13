import { useEffect, useState } from 'react';
import type { ChildAgentInfo, ChildAgentList } from '../../../shared/child-agents';
import { onKeyActivate } from '../../utils/a11y';
import {
  CHILD_AGENT_ROW_LIMIT,
  childAgentKind,
  childAgentSummary,
  childAgentsHeading,
  describeChildAgentTokens,
  formatChildAgentModel,
  formatChildAgentTiming,
  formatChildAgentTokens,
  selectVisibleChildAgents,
} from '../../utils/child-agents';

interface ChildAgentRowsProps {
  sessionLabel: string;
  list: ChildAgentList;
  expanded: boolean;
  onToggle: () => void;
  onOpen: (agent: ChildAgentInfo) => void;
}

/** Re-render once a second while something is running so "running 2m" counts up. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function ChildAgentRows({ sessionLabel, list, expanded, onToggle, onOpen }: Readonly<ChildAgentRowsProps>) {
  const [showAll, setShowAll] = useState(false);
  const running = list.agents.filter(a => a.state === 'running').length;
  const now = useNow(expanded && running > 0);
  const { visible, hidden } = selectVisibleChildAgents(list.agents, CHILD_AGENT_ROW_LIMIT, showAll);
  const unlisted = Math.max(0, list.total - list.agents.length);

  if (list.agents.length === 0) return null;

  return (
    <div className="child-agents" role="group" aria-label={`${list.agents.some(a => a.source === 'codex-exec') ? 'Child agents' : 'Subagents'} of ${sessionLabel}`}>
      <div
        className="child-agents-toggle"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={onToggle}
        onKeyDown={onKeyActivate(onToggle)}
      >
        <span className="child-agents-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        <span>{childAgentsHeading(list)}</span>
        {running > 0 && <span className="child-agents-running">{running} running</span>}
      </div>
      {expanded && visible.map(agent => {
        const isRunning = agent.state === 'running';
        const model = formatChildAgentModel(agent);
        return (
          <div
            key={agent.id}
            className="child-agent-row"
            role="button"
            tabIndex={0}
            style={{ paddingLeft: `calc(var(--child-agent-indent) + ${Math.max(0, agent.depth - 1) * 12}px)` }}
            aria-label={`${childAgentKind(agent)} ${childAgentSummary(agent, now)}. Open transcript`}
            title={describeChildAgentTokens(agent.tokens)}
            onClick={() => onOpen(agent)}
            onKeyDown={onKeyActivate(() => onOpen(agent))}
          >
            <span className={`status-dot status-dot--${isRunning ? 'running' : 'idle'}`} aria-hidden="true" />
            <div className="child-agent-info">
              <span className="child-agent-title">
                {'↳'} {agent.agentType}{agent.description ? ` · ${agent.description}` : ''}
              </span>
              <span className="child-agent-meta">
                {[model, formatChildAgentTiming(agent, now), formatChildAgentTokens(agent.tokens)].filter(Boolean).join(' · ')}
              </span>
            </div>
          </div>
        );
      })}
      {expanded && hidden > 0 && (
        <div
          className="child-agents-more"
          role="button"
          tabIndex={0}
          onClick={() => setShowAll(true)}
          onKeyDown={onKeyActivate(() => setShowAll(true))}
        >
          +{hidden} more
        </div>
      )}
      {expanded && unlisted > 0 && (
        <div className="child-agents-note">{unlisted} older not shown</div>
      )}
    </div>
  );
}
