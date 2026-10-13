import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChildAgentList } from '../../shared/child-agents';
import type { EnvironmentInfo, SessionInfo } from '../../shared/types';
import { supportsChildAgents } from '../utils/child-agents';

/** Must match `SHOW_SUBAGENTS_CONFIG_KEY` in the main process. */
export const SHOW_SUBAGENTS_CONFIG_KEY = 'showSubagentsInSidebar';

export interface ChildAgentsState {
  lists: ReadonlyMap<string, ChildAgentList>;
  expandedIds: ReadonlySet<string>;
  toggleExpanded(sessionId: string): void;
}

const NONE: ReadonlyMap<string, ChildAgentList> = new Map();

/**
 * Subagent rows for local Claude sessions: one list fetch per session once its
 * Claude id is known, then pushes from main as subagents come and go. Does
 * nothing while the "Show subagents in sidebar" setting is off.
 */
export function useChildAgents(
  sessions: readonly SessionInfo[],
  environmentById: ReadonlyMap<string, EnvironmentInfo>,
): ChildAgentsState {
  // Unknown until the setting has been read, so an off setting never fetches.
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [lists, setLists] = useState<ReadonlyMap<string, ChildAgentList>>(NONE);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set());
  const expandedRef = useRef<ReadonlySet<string>>(expandedIds);
  const fetched = useRef(new Set<string>());

  useEffect(() => {
    let active = true;
    let generation = 0;
    const read = () => {
      const request = ++generation;
      Promise.resolve(window.electronAPI.config.get(SHOW_SUBAGENTS_CONFIG_KEY))
        .then(value => { if (active && request === generation) setEnabled(value !== 'false'); })
        .catch(() => { if (active && request === generation) setEnabled(true); });
    };
    read();
    window.addEventListener('tether:settings-changed', read);
    return () => { active = false; window.removeEventListener('tether:settings-changed', read); };
  }, []);

  useEffect(() => {
    const api = window.electronAPI.subagents;
    if (!enabled || !api) {
      fetched.current.clear();
      setLists(NONE);
      return;
    }
    return api.onUpdate((sessionId, list) => {
      setLists(prev => new Map(prev).set(sessionId, list));
    });
  }, [enabled]);

  const eligible = useMemo(() => sessions
    .filter(s => supportsChildAgents(s, environmentById))
    .map(s => ({ id: s.id, key: `${s.id}:${s.claudeSessionId ?? s.toolSessionId}` })),
  [sessions, environmentById]);
  const eligibleSignature = eligible.map(e => e.key).join('|');

  useEffect(() => {
    const api = window.electronAPI.subagents;
    if (!enabled || !api) return;
    let active = true;
    for (const { id, key } of eligible) {
      if (fetched.current.has(key)) continue;
      fetched.current.add(key);
      api.list(id)
        .then(list => { if (active) setLists(prev => new Map(prev).set(id, list)); })
        .catch(() => { fetched.current.delete(key); });
    }
    const live = new Set(sessions.map(s => s.id));
    setLists(prev => {
      const stale = [...prev.keys()].filter(id => !live.has(id));
      if (stale.length === 0) return prev;
      const next = new Map(prev);
      for (const id of stale) next.delete(id);
      return next;
    });
    return () => { active = false; };
  }, [enabled, eligibleSignature, sessions.length]);

  const toggleExpanded = useCallback((sessionId: string) => {
    const open = !expandedRef.current.has(sessionId);
    const next = new Set(expandedRef.current);
    if (open) next.add(sessionId); else next.delete(sessionId);
    expandedRef.current = next;
    setExpandedIds(next);
    window.electronAPI.subagents?.setExpanded(sessionId, open);
  }, []);

  return { lists: enabled === true ? lists : NONE, expandedIds, toggleExpanded };
}
