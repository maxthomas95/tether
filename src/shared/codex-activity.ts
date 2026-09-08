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
  currentTurnId?: string;
  completedTurnIds?: string[];
}

export type CodexLifecycleEventType =
  | 'session_start'
  | 'turn_start'
  | 'permission_prompt'
  | 'tool_complete'
  | 'compact_start'
  | 'compact_complete'
  | 'subagent_start'
  | 'subagent_stop'
  | 'turn_complete'
  | 'turn_interrupted'
  | 'session_end';

export interface CodexLifecycleMetadata {
  toolSessionId?: string;
  turnId?: string;
  agentId?: string;
  model?: string;
  at?: string;
}
