import { createTrustedIpc } from './trusted-ipc';
import { IPC } from '../../shared/constants';
import type { ChildAgentList, ChildAgentTranscript } from '../../shared/child-agents';
import { EMPTY_CHILD_AGENT_LIST } from '../../shared/child-agents';
import { sessionManager } from '../session/session-manager';
import { statusDetector } from '../status/status-detector';
import { getEnvironment } from '../db/environment-repo';
import { getDb } from '../db/database';
import { subagentTracker } from '../claude/subagent-tracker';
import { openRemoteSubagentSource } from '../claude/remote-subagents';
import type { HandlerContext } from './helpers';

/** Sidebar subagent rows default on; only the literal 'false' turns them off. */
export const SHOW_SUBAGENTS_CONFIG_KEY = 'showSubagentsInSidebar';

export function registerSubagentHandlers(ctx: HandlerContext): void {
  const ipc = createTrustedIpc(ctx.mainWindow);

  subagentTracker.configure({
    isEnabled: () => getDb().config[SHOW_SUBAGENTS_CONFIG_KEY] !== 'false',
    openRemote: (target, sessionId) => openRemoteSubagentSource({ target, sessionId }),
    resolve: sessionId => {
      const session = sessionManager.getSession(sessionId);
      if (!session) return null;
      const env = session.environmentId ? getEnvironment(session.environmentId) : undefined;
      return {
        cliTool: session.cliTool,
        workingDir: session.workingDir,
        nativeSessionId: session.claudeSessionId ?? session.toolSessionId,
        local: !session.environmentId || env?.type === 'local',
        remote: env?.type === 'ssh' || env?.type === 'coder' ? session.remoteProbe : undefined,
        alive: session.state !== 'stopped' && session.state !== 'dead',
        hookDriven: statusDetector.isHookDriven(sessionId),
        activeAgentIds: statusDetector.getActiveSubagentIds(sessionId),
      };
    },
  });

  subagentTracker.onUpdate((sessionId, list) => ctx.send(IPC.SUBAGENTS_UPDATED, sessionId, list));

  sessionManager.addLifecycleObserver({
    onStateChanged: session => subagentTracker.notify(session.id),
    onSubagentEvent: session => subagentTracker.notify(session.id, { subagentEvent: true }),
    onRemoved: id => subagentTracker.untrack(id),
  });

  ipc.handle(IPC.SUBAGENTS_LIST, async (_event, sessionId: unknown): Promise<ChildAgentList> => {
    if (typeof sessionId !== 'string') return EMPTY_CHILD_AGENT_LIST;
    return subagentTracker.list(sessionId);
  });

  ipc.handle(IPC.SUBAGENTS_TRANSCRIPT, async (_event, sessionId: unknown, agentId: unknown): Promise<ChildAgentTranscript | null> => {
    if (typeof sessionId !== 'string' || typeof agentId !== 'string') return null;
    return subagentTracker.getTranscript(sessionId, agentId);
  });

  ipc.on(IPC.SUBAGENTS_RELEASE_TRANSCRIPT, (_event, sessionId: unknown, agentId: unknown) => {
    if (typeof sessionId !== 'string' || typeof agentId !== 'string') return;
    subagentTracker.releaseTranscript(sessionId, agentId);
  });

  // A reloaded or crashed renderer starts with every list collapsed and no viewer open.
  ctx.mainWindow.webContents.on('render-process-gone', () => subagentTracker.resetExpanded());
  ctx.mainWindow.webContents.on('did-start-loading', () => subagentTracker.resetExpanded());

  ipc.on(IPC.SUBAGENTS_SET_EXPANDED, (_event, sessionId: unknown, expanded: unknown) => {
    if (typeof sessionId !== 'string') return;
    subagentTracker.setExpanded(sessionId, expanded === true);
  });
}
