import type {
  CodexLifecycleEventType,
  CodexLifecycleMetadata,
  CodexSessionActivity,
} from '../../shared/codex-activity';

export const MAX_CODEX_ACTIVE_SUBAGENTS = 64;
export const MAX_CODEX_COMPLETED_TURNS = 32;

export function initialCodexSessionActivity(): CodexSessionActivity {
  return {
    lastHookAt: null,
    phase: 'running',
    activeSubagentIds: [],
    compactionCount: 0,
  };
}

export function reduceCodexSessionActivity(
  current: CodexSessionActivity | undefined,
  type: CodexLifecycleEventType,
  metadata: CodexLifecycleMetadata,
): CodexSessionActivity {
  if (current?.lastHookAt && metadata.at && Date.parse(metadata.at) < Date.parse(current.lastHookAt)) {
    return current;
  }
  const next: CodexSessionActivity = {
    ...(current ?? initialCodexSessionActivity()),
    activeSubagentIds: [...(current?.activeSubagentIds ?? [])],
    completedTurnIds: current?.completedTurnIds ? [...current.completedTurnIds] : undefined,
  };
  next.lastHookAt = metadata.at ?? new Date().toISOString();
  if (metadata.model) next.observedModel = metadata.model;
  const mayReturnToRunning = next.phase !== 'permission' &&
    next.phase !== 'complete' &&
    next.phase !== 'interrupted';

  switch (type) {
    case 'session_start':
    case 'turn_start':
      if (metadata.turnId) next.currentTurnId = metadata.turnId;
      next.phase = 'running';
      break;
    case 'tool_complete':
      next.phase = 'running';
      break;
    case 'permission_prompt':
      next.phase = 'permission';
      break;
    case 'compact_start':
      next.phase = 'compacting';
      break;
    case 'compact_complete':
      if (next.phase !== 'compacting') return current ?? next;
      next.phase = 'running';
      next.compactionCount += 1;
      break;
    case 'subagent_start':
      if (metadata.agentId && !next.activeSubagentIds.includes(metadata.agentId)) {
        next.activeSubagentIds = [...next.activeSubagentIds, metadata.agentId].slice(-MAX_CODEX_ACTIVE_SUBAGENTS);
      }
      if (mayReturnToRunning) next.phase = 'running';
      break;
    case 'subagent_stop':
      if (metadata.agentId) {
        next.activeSubagentIds = next.activeSubagentIds.filter((id) => id !== metadata.agentId);
      }
      if (mayReturnToRunning) next.phase = 'running';
      break;
    case 'turn_complete':
    case 'session_end':
      next.phase = 'complete';
      next.activeSubagentIds = [];
      if (metadata.turnId) {
        const completed = next.completedTurnIds ?? [];
        next.completedTurnIds = [...completed.filter((id) => id !== metadata.turnId), metadata.turnId]
          .slice(-MAX_CODEX_COMPLETED_TURNS);
        if (next.currentTurnId === metadata.turnId) delete next.currentTurnId;
      }
      break;
    case 'turn_interrupted':
      next.phase = 'interrupted';
      next.activeSubagentIds = [];
      if (metadata.turnId && next.currentTurnId === metadata.turnId) delete next.currentTurnId;
      break;
  }

  return next;
}
