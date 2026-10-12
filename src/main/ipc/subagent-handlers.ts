import { createTrustedIpc } from './trusted-ipc';
import { IPC } from '../../shared/constants';
import type { ChildAgentList, ChildAgentTranscript } from '../../shared/child-agents';
import { EMPTY_CHILD_AGENT_LIST } from '../../shared/child-agents';
import { sessionManager } from '../session/session-manager';
import { statusDetector } from '../status/status-detector';
import { getEnvironment } from '../db/environment-repo';
import { getDb } from '../db/database';
import { subagentTracker } from '../claude/subagent-tracker';
import { codexExecTracker } from '../codex/exec-tracker';
import { getCodexHome } from '../codex/transcripts';
import type { HandlerContext } from './helpers';

/** Sidebar subagent rows default on; only the literal 'false' turns them off. */
export const SHOW_SUBAGENTS_CONFIG_KEY = 'showSubagentsInSidebar';

/** Claude's subagents first, then the `codex exec` runs the session started. */
export function mergeChildAgentLists(subagents: ChildAgentList, execRuns: ChildAgentList): ChildAgentList {
  if (execRuns.agents.length === 0) return subagents;
  if (subagents.agents.length === 0) return execRuns;
  return { agents: [...subagents.agents, ...execRuns.agents], total: subagents.total + execRuns.total };
}

export function registerSubagentHandlers(ctx: HandlerContext): void {
  const ipc = createTrustedIpc(ctx.mainWindow);
  const subagentLists = new Map<string, ChildAgentList>();
  const execLists = new Map<string, ChildAgentList>();
  const merged = (sessionId: string) => mergeChildAgentLists(
    subagentLists.get(sessionId) ?? EMPTY_CHILD_AGENT_LIST,
    execLists.get(sessionId) ?? EMPTY_CHILD_AGENT_LIST,
  );

  subagentTracker.configure({
    isEnabled: () => getDb().config[SHOW_SUBAGENTS_CONFIG_KEY] !== 'false',
    resolve: sessionId => {
      const session = sessionManager.getSession(sessionId);
      if (!session) return null;
      const env = session.environmentId ? getEnvironment(session.environmentId) : undefined;
      return {
        cliTool: session.cliTool,
        workingDir: session.workingDir,
        nativeSessionId: session.claudeSessionId ?? session.toolSessionId,
        local: !session.environmentId || env?.type === 'local',
        alive: session.state !== 'stopped' && session.state !== 'dead',
        hookDriven: statusDetector.isHookDriven(sessionId),
        activeAgentIds: statusDetector.getActiveSubagentIds(sessionId),
      };
    },
  });

  codexExecTracker.configure({
    isEnabled: () => getDb().config[SHOW_SUBAGENTS_CONFIG_KEY] !== 'false',
    codexHome: getCodexHome,
    resolve: sessionId => {
      const session = sessionManager.getSession(sessionId);
      if (!session) return null;
      const env = session.environmentId ? getEnvironment(session.environmentId) : undefined;
      return {
        cliTool: session.cliTool,
        local: !session.environmentId || env?.type === 'local',
        alive: session.state !== 'stopped' && session.state !== 'dead',
      };
    },
  });

  subagentTracker.onUpdate((sessionId, list) => {
    subagentLists.set(sessionId, list);
    ctx.send(IPC.SUBAGENTS_UPDATED, sessionId, merged(sessionId));
  });
  codexExecTracker.onUpdate((sessionId, list) => {
    execLists.set(sessionId, list);
    ctx.send(IPC.SUBAGENTS_UPDATED, sessionId, merged(sessionId));
  });

  sessionManager.addLifecycleObserver({
    onStateChanged: session => { subagentTracker.notify(session.id); codexExecTracker.notify(session.id); },
    onSubagentEvent: session => subagentTracker.notify(session.id, { subagentEvent: true }),
    onCodexExecEvent: (session, event) => codexExecTracker.ingest(session.id, event),
    onRemoved: id => {
      subagentTracker.untrack(id);
      codexExecTracker.untrack(id);
      subagentLists.delete(id);
      execLists.delete(id);
    },
  });

  ipc.handle(IPC.SUBAGENTS_LIST, async (_event, sessionId: unknown): Promise<ChildAgentList> => {
    if (typeof sessionId !== 'string') return EMPTY_CHILD_AGENT_LIST;
    const [subagents, execRuns] = await Promise.all([subagentTracker.list(sessionId), codexExecTracker.list(sessionId)]);
    subagentLists.set(sessionId, subagents);
    execLists.set(sessionId, execRuns);
    return mergeChildAgentLists(subagents, execRuns);
  });

  ipc.handle(IPC.SUBAGENTS_TRANSCRIPT, async (_event, sessionId: unknown, agentId: unknown): Promise<ChildAgentTranscript | null> => {
    if (typeof sessionId !== 'string' || typeof agentId !== 'string') return null;
    if (codexExecTracker.has(sessionId, agentId)) return codexExecTracker.getTranscript(sessionId, agentId);
    return subagentTracker.getTranscript(sessionId, agentId);
  });

  ipc.on(IPC.SUBAGENTS_RELEASE_TRANSCRIPT, (_event, sessionId: unknown, agentId: unknown) => {
    if (typeof sessionId !== 'string' || typeof agentId !== 'string') return;
    subagentTracker.releaseTranscript(sessionId, agentId);
    codexExecTracker.releaseTranscript(sessionId, agentId);
  });

  // A reloaded or crashed renderer starts with every list collapsed and no viewer open.
  const resetExpanded = () => { subagentTracker.resetExpanded(); codexExecTracker.resetExpanded(); };
  ctx.mainWindow.webContents.on('render-process-gone', resetExpanded);
  ctx.mainWindow.webContents.on('did-start-loading', resetExpanded);

  ipc.on(IPC.SUBAGENTS_SET_EXPANDED, (_event, sessionId: unknown, expanded: unknown) => {
    if (typeof sessionId !== 'string') return;
    subagentTracker.setExpanded(sessionId, expanded === true);
    codexExecTracker.setExpanded(sessionId, expanded === true);
  });
}
