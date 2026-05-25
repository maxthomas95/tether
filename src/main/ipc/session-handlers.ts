import { ipcMain } from 'electron';
import { IPC } from '../../shared/constants';
import type {
  CreateSessionOptions,
  VaultPreflightResult,
  SessionExitInfo,
  SessionState,
  SessionInfo,
  CliToolId,
  WaitingReason,
} from '../../shared/types';
import { sessionManager, findVaultRefInSession, setHelmChildCallbacks } from '../session/session-manager';
import { usageService } from '../usage/usage-service';
import * as sessionRepo from '../db/session-repo';
import { getStatus as getVaultStatus } from '../vault/vault-auth';
import { createLogger } from '../logger';
import type { HandlerContext } from './helpers';

const log = createLogger('ipc:session');

export function registerSessionHandlers(ctx: HandlerContext): void {
  const { send } = ctx;

  // Single callback bundle, shared between direct IPC session creation and
  // Helm-dispatched children. See `setHelmChildCallbacks` for the rationale.
  const sessionCallbacks = {
    onData(sessionId: string, data: string) {
      send(IPC.SESSION_DATA, sessionId, data);
    },
    onStateChange(sessionId: string, state: SessionState, waitingReason?: WaitingReason) {
      send(IPC.SESSION_STATE_CHANGE, sessionId, state, waitingReason);
      sessionRepo.updateSessionState(sessionId, state);
    },
    onUpdate(sessionId: string, info: SessionInfo) {
      send(IPC.SESSION_UPDATED, sessionId, info);
    },
    onCreated(sessionId: string, info: SessionInfo) {
      send(IPC.SESSION_CREATED, sessionId, info);
    },
    onExit(sessionId: string, exitInfo: SessionExitInfo) {
      send(IPC.SESSION_EXITED, sessionId, exitInfo);
      const s = sessionManager.getSession(sessionId);
      if (s?.claudeSessionId) {
        usageService.untrackSession(s.claudeSessionId);
      }
      if (s?.cliTool && s.cliTool !== 'claude' && s.toolSessionId) {
        usageService.untrackSession(s.toolSessionId);
      }
    },
  };
  setHelmChildCallbacks(sessionCallbacks);

  ipcMain.handle(IPC.SESSION_CREATE, async (_event, opts: CreateSessionOptions) => {
    log.info('IPC session:create', { workingDir: opts.workingDir, environmentId: opts.environmentId });
    // Callbacks receive sessionId as their first arg — do NOT close over the
    // `session` const below. SSH transports can emit data events between
    // `transport.start()` resolving and the `await` unblocking, which would
    // hit the temporal dead zone on the const binding (v0.1.3 SSH crash).
    const session = await sessionManager.createSession(opts, sessionCallbacks);

    // Persist to DB
    sessionRepo.createSessionRow({
      label: session.label,
      working_dir: session.workingDir,
      environment_id: opts.environmentId,
      state: 'running',
    });

    // Start tracking usage for Claude sessions
    if (session.claudeSessionId) {
      usageService.trackSession(session.claudeSessionId, session.workingDir, 'claude', session.environmentId ?? undefined);
    }

    // Start tracking usage for OpenCode sessions (only when toolSessionId is
    // already set — e.g. resume. New OpenCode sessions get tracked from the
    // session-manager's detect callback once the id lands.)
    if (session.cliTool === 'opencode' && session.toolSessionId) {
      usageService.trackSession(session.toolSessionId, session.workingDir, 'opencode', session.environmentId ?? undefined);
    }

    return session.toInfo();
  });

  ipcMain.handle(IPC.SESSION_VAULT_PREFLIGHT, async (_event, opts: CreateSessionOptions): Promise<VaultPreflightResult> => {
    const status = getVaultStatus();
    // If Vault isn't enabled or we're already logged in, skip the scan — nothing to prompt about.
    if (!status.enabled || status.loggedIn) return { needsLogin: false };
    const refSource = await findVaultRefInSession(opts);
    if (!refSource) return { needsLogin: false };
    return { needsLogin: true, reason: refSource };
  });

  ipcMain.handle(IPC.SESSION_LIST, async () => {
    return sessionManager.listSessions().map(s => s.toInfo());
  });

  ipcMain.handle(IPC.SESSION_STOP, async (_event, sessionId: string) => {
    await sessionManager.stopSession(sessionId);
  });

  ipcMain.handle(IPC.SESSION_RENAME, async (_event, sessionId: string, label: string) => {
    sessionManager.renameSession(sessionId, label);
    sessionRepo.updateSessionLabel(sessionId, label);
  });

  ipcMain.handle(IPC.SESSION_SET_HELM_ENABLED, async (_event, sessionId: string, enabled: boolean) => {
    sessionManager.setHelmEnabled(sessionId, enabled);
  });

  ipcMain.handle(IPC.SESSION_REMOVE, async (_event, sessionId: string) => {
    sessionManager.removeSession(sessionId);
  });

  ipcMain.on(IPC.SESSION_INPUT, (_event, sessionId: string, data: string) => {
    sessionManager.writeToSession(sessionId, data);
  });

  ipcMain.on(IPC.SESSION_RESIZE, (_event, sessionId: string, cols: number, rows: number) => {
    sessionManager.resizeSession(sessionId, cols, rows);
  });

  // === Workspace save/restore ===

  ipcMain.handle(IPC.WORKSPACE_SAVE, async (_event, sessions: Array<{ workingDir: string; label: string; environmentId?: string; cliTool?: string; customCliBinary?: string; toolSessionId?: string; claudeSessionId?: string }>, activeIndex: number) => {
    const { getDb, saveDb } = await import('../db/database');
    // Codex toolSessionIds are captured at spawn time via the codex session
    // watcher and pushed to the renderer, so whatever the renderer hands us
    // here is already the real conversation id (or undefined if codex hadn't
    // written its transcript yet — in which case we'd rather not resume than
    // resume a stale/unrelated conversation).
    getDb().savedWorkspace = { sessions, activeIndex };
    saveDb();
  });

  ipcMain.handle(IPC.WORKSPACE_LOAD, async () => {
    const { getDb } = await import('../db/database');
    return getDb().savedWorkspace;
  });

  ipcMain.handle(IPC.TRANSCRIPTS_LIST, async (_event, workingDir: string, cliTool: CliToolId = 'claude') => {
    if (cliTool === 'codex') {
      const { listCodexTranscripts } = await import('../codex/transcripts');
      return listCodexTranscripts(workingDir);
    }
    if (cliTool === 'copilot') {
      const { listCopilotTranscripts } = await import('../copilot/transcripts');
      return listCopilotTranscripts(workingDir);
    }
    if (cliTool === 'opencode') {
      const { listOpencodeTranscripts } = await import('../opencode/transcripts');
      return listOpencodeTranscripts(workingDir);
    }
    const { listTranscripts } = await import('../claude/transcripts');
    return listTranscripts(workingDir);
  });
}
