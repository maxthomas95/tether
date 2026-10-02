import { createTrustedIpc } from './trusted-ipc';
import { IPC } from '../../shared/constants';
import type { HandlerContext } from './helpers';
import type { KeybindingOverrides } from '../../shared/keybindings';

export function registerKeybindingsHandlers(_ctx: HandlerContext): void {
  const ipc = createTrustedIpc(_ctx.mainWindow);
  ipc.handle(IPC.KEYBINDINGS_GET, async () => {
    const { getDb } = await import('../db/database');
    return getDb().keybindings ?? {};
  });

  ipc.handle(IPC.KEYBINDINGS_SET, async (_event, overrides: KeybindingOverrides) => {
    const { getDb, saveDb } = await import('../db/database');
    const db = getDb();
    db.keybindings = overrides && typeof overrides === 'object' ? overrides : {};
    saveDb();
  });

  ipc.handle(IPC.KEYBINDINGS_RESET_ALL, async () => {
    const { getDb, saveDb } = await import('../db/database');
    const db = getDb();
    db.keybindings = {};
    saveDb();
  });
}
