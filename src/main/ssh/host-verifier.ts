import { v4 as uuidv4 } from 'uuid';
import { findKnownHost, saveKnownHost } from '../db/known-hosts-repo';
import { createLogger } from '../logger';
import type { HostVerifyRequest } from '../../shared/types';

const log = createLogger('ssh-host-verifier');

const VERIFY_TIMEOUT_MS = 60_000;

let dispatchPrompt: ((req: HostVerifyRequest) => void) | null = null;
const pending = new Map<string, (trust: boolean) => void>();

export function setHostVerifyDispatcher(dispatcher: (req: HostVerifyRequest) => void): void {
  dispatchPrompt = dispatcher;
}

export interface VerifyResult {
  trust: boolean;
  /** When trust is false, an end-user explanation suitable for the session error UI. */
  reason?: string;
}

export async function verifyHost(
  host: string,
  port: number,
  keyHash: string,
  username?: string,
): Promise<VerifyResult> {
  const hostKey = `${host}:${port || 22}`;
  const known = findKnownHost(hostKey);

  if (known) {
    if (known.keyHash === keyHash) {
      return { trust: true };
    }
    log.error('Host key changed', {
      hostKey,
      oldHash: known.keyHash.slice(0, 16),
      newHash: keyHash.slice(0, 16),
    });
    return {
      trust: false,
      reason:
        `Host key for ${hostKey} has changed. ` +
        `Stored: SHA256:${known.keyHash.slice(0, 12)}…, received: SHA256:${keyHash.slice(0, 12)}…. ` +
        `If this is expected, revoke the entry under Settings → SSH Known Hosts and reconnect.`,
    };
  }

  if (!dispatchPrompt) {
    log.error('Host verify dispatcher not set; refusing connection');
    return { trust: false, reason: 'SSH host verification is not initialized' };
  }

  const token = uuidv4();
  log.info('Prompting user for host key trust', { hostKey });

  return new Promise<VerifyResult>((resolve) => {
    const timer = setTimeout(() => {
      if (pending.has(token)) {
        pending.delete(token);
        log.warn('Host verify timed out', { hostKey });
        resolve({ trust: false, reason: 'Host key verification timed out (no user response)' });
      }
    }, VERIFY_TIMEOUT_MS);

    pending.set(token, (trust) => {
      clearTimeout(timer);
      if (trust) {
        try {
          saveKnownHost({ hostKey, keyHash, keyType: 'unknown' });
        } catch (err) {
          log.error('Failed to persist trusted host', {
            hostKey,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        resolve({ trust: true });
      } else {
        resolve({ trust: false, reason: 'Host key verification rejected by user' });
      }
    });

    dispatchPrompt!({ token, host, port: port || 22, username, keyHash });
  });
}

export function respondToHostVerify(token: string, trust: boolean): void {
  const cb = pending.get(token);
  if (cb) {
    pending.delete(token);
    cb(trust);
  }
}
