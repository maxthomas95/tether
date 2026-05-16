import { BrowserWindow } from 'electron';
import type { HandlerContext } from './helpers';
import { registerSessionHandlers } from './session-handlers';
import { registerEnvHandlers } from './env-handlers';
import { registerCoderHandlers } from './coder-handlers';
import { registerProfileHandlers } from './profile-handlers';
import { registerConfigHandlers } from './config-handlers';
import { registerDialogHandlers } from './dialog-handlers';
import { registerGitHandlers } from './git-handlers';
import { registerVaultHandlers } from './vault-handlers';
import { registerSystemHandlers } from './system-handlers';
import { registerUsageHandlers } from './usage-handlers';
import { registerSshHandlers } from './ssh-handlers';
import { registerKeybindingsHandlers } from './keybindings-handlers';

/**
 * Wire up every IPC handler against the renderer window. The actual handler
 * bodies live in domain modules — this file is a dispatcher.
 */
export function registerIpcHandlers(mainWindow: BrowserWindow): void {
  const ctx: HandlerContext = {
    mainWindow,
    send(channel: string, ...args: unknown[]) {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, ...args);
      }
    },
  };

  registerSshHandlers(ctx);
  registerSessionHandlers(ctx);
  registerEnvHandlers(ctx);
  registerCoderHandlers(ctx);
  registerProfileHandlers(ctx);
  registerDialogHandlers(ctx);
  registerConfigHandlers(ctx);
  registerGitHandlers(ctx);
  registerVaultHandlers(ctx);
  registerSystemHandlers(ctx);
  registerUsageHandlers(ctx);
  registerKeybindingsHandlers(ctx);
}
