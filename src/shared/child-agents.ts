/**
 * Agents a CLI session spawned that have no terminal of their own: Claude Code
 * subagents, and `codex exec` runs a Claude session launched through its Bash
 * tool. The model is generic so another CLI's helpers can join it later by
 * adding a `source` rather than reshaping the rows.
 */
export type ChildAgentSource = 'claude-subagent' | 'codex-exec';

export interface ChildAgentTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ChildAgentInfo {
  source: ChildAgentSource;
  /** Stable within the parent session; for Claude it is the hook `agent_id`. */
  id: string;
  agentType: string;
  description: string;
  /** What the parent asked for. Absent when the child inherited the parent's. */
  requestedModel?: string;
  /** What actually answered, taken from the child's last assistant message. */
  model?: string;
  effort?: string;
  background: boolean;
  /** 1 for a direct child of the session, 2 for a child of a child, and so on. */
  depth: number;
  /** Id of the child that spawned this one, when that child is still listed. */
  parentId?: string;
  /** Id of the tool call in the parent that spawned this agent. */
  parentToolUseId?: string;
  state: 'running' | 'done';
  /** ISO timestamps. */
  startedAt: string;
  lastActivityAt: string;
  tokens: ChildAgentTokens;
}

export interface ChildAgentList {
  /** In display order: parents before their children, otherwise oldest first. */
  agents: ChildAgentInfo[];
  /** Agents found on disk; can exceed `agents.length` when the list is capped. */
  total: number;
}

export type ChildTranscriptEntry =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; summary: string; failed?: boolean };

/** Read-only digest of a child's transcript for the viewer. */
export interface ChildAgentTranscript {
  agent: ChildAgentInfo;
  /** The task the child was given. */
  prompt: string | null;
  /** Assistant text and tool calls in order, without tool output. */
  entries: ChildTranscriptEntry[];
  /** The child's last assistant text, once it has finished. */
  result: string | null;
  /** True when the file was too large to read in full or entries were dropped. */
  truncated: boolean;
  /** Why there is little to show, e.g. a run that wrote no rollout file. */
  note?: string;
}

export const EMPTY_CHILD_AGENT_LIST: ChildAgentList = Object.freeze({ agents: [], total: 0 }) as ChildAgentList;
