import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC } from '../../shared/constants';
import { readCodexAccount, inspectCodexConfiguration } from '../codex/integration-service';
import { sessionManager } from '../session/session-manager';
import { getEnvironment } from '../db/environment-repo';
import type { HandlerContext } from './helpers';

/** Only Tether's own top-level renderer can request local account/config metadata. */
export function registerCodexHandlers({ mainWindow }: HandlerContext): void {
  function checkSender(event: IpcMainInvokeEvent): void {
    if (mainWindow.isDestroyed() || event.sender !== mainWindow.webContents
      || event.senderFrame !== mainWindow.webContents.mainFrame) {
      throw new Error('Codex inspection is only available in the Tether window.');
    }
  }

  ipcMain.handle(IPC.CODEX_ACCOUNT, async (event) => {
    checkSender(event);
    return readCodexAccount();
  });

  ipcMain.handle(IPC.CODEX_CONFIGURATION, async (event, sessionId?: unknown) => {
    checkSender(event);
    if (sessionId === undefined) return inspectCodexConfiguration();
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) {
      throw new Error('Choose a local Codex session to inspect.');
    }
    const session = sessionManager.getSession(sessionId);
    if (!session || session.cliTool !== 'codex') {
      throw new Error('This Codex session is no longer available.');
    }
    const environment = session.environmentId ? getEnvironment(session.environmentId) : undefined;
    if (session.environmentId && (!environment || environment.type !== 'local')) {
      throw new Error('Configuration inspection is available for local Codex sessions.');
    }
    return inspectCodexConfiguration(session.workingDir);
  });
}
