import { ipcMain } from 'electron';
import { IPC } from '../../shared/constants';
import type { KnownHostInfo, HostVerifyRequest } from '../../shared/types';
import { setHostVerifyDispatcher, respondToHostVerify } from '../ssh/host-verifier';
import * as knownHostsRepo from '../db/known-hosts-repo';
import { createLogger } from '../logger';
import type { HandlerContext } from './helpers';

const log = createLogger('ipc:ssh');

export function registerSshHandlers(ctx: HandlerContext): void {
  const { send } = ctx;

  // Wire the SSH host-verify prompt dispatcher to the renderer. The verifier
  // module holds the pending callbacks; we just need it to know how to push
  // the prompt out.
  setHostVerifyDispatcher((req: HostVerifyRequest) => {
    send(IPC.SSH_HOST_VERIFY_REQUEST, req);
  });

  ipcMain.on(IPC.SSH_HOST_VERIFY_RESPONSE, (_event, token: string, trust: boolean) => {
    respondToHostVerify(token, trust);
  });

  ipcMain.handle(IPC.KNOWN_HOSTS_LIST, async (): Promise<KnownHostInfo[]> => {
    return knownHostsRepo.listKnownHosts().map((h) => ({
      id: h.id,
      hostKey: h.hostKey,
      keyHash: h.keyHash,
      keyType: h.keyType,
      trustedAt: h.trustedAt,
      firstSeen: h.firstSeen,
    }));
  });

  ipcMain.handle(IPC.KNOWN_HOSTS_DELETE, async (_event, id: string): Promise<void> => {
    log.info('Revoking known host', { id });
    knownHostsRepo.deleteKnownHost(id);
  });
}
