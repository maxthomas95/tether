import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createLogger } from '../logger';
import {
  handleConnection,
  HookTokenRegistry,
  type HookEvent,
  type HookEventHandler,
  type TokenValidator,
} from './hook-frame-server';

const log = createLogger('hook-bridge');

/**
 * Long-lived, process-wide socket that receives waiting-signal events from
 * CLI hook processes (Claude `Notification`/`Stop`, Codex `notify`). One
 * listener serves every session — sessions are demultiplexed by the
 * `tetherSessionId` field on each frame, which we inject into the CLI
 * process env at spawn time and the hook helper passes through to us.
 *
 * This module is now a thin `net.Server` shell: per-connection auth, framing,
 * and dispatch live in the stream-agnostic `hook-frame-server`, so a future
 * ssh2-forwarded stream can be served identically by handing it to
 * `handleConnection` directly.
 *
 * Protocol (one JSON object per `\n`-terminated line):
 *   First frame  : { id: "auth", method: "authenticate", token: "<hex>" }
 *   Subsequent   : { id, method: "event", tetherSessionId, type, payload? }
 * Bad/missing token → error frame + close. Unknown method → error frame.
 *
 * Threat model: an attacker who reads the token from the CLI process env
 * (via /proc or ProcExp) can post fake events. Blast radius is cosmetic —
 * the bridge only flips session-status indicators, it cannot inject input
 * into the PTY, exfiltrate transcripts, or spawn sessions. The token is
 * regenerated every Tether boot so leaks don't outlive the app process.
 */

// Re-export the protocol types so existing importers (hook-service, tests)
// don't have to chase the new module split.
export type { HookEvent, HookEventHandler, HookEventType, TokenValidator } from './hook-frame-server';

export interface HookBridgeHandle {
  /** Address the hook helper dials. Passed to spawned CLIs via TETHER_HOOK_SOCKET. */
  readonly socketPath: string;
  /** Random per-boot secret the hook helper must present. Passed via TETHER_HOOK_TOKEN. */
  readonly token: string;
  /**
   * Mint a per-session token scoped to `sessionId`. Frames presenting it are
   * only accepted when their `tetherSessionId` matches. Idempotent per id.
   * Local sessions don't need this — they all use the boot-global `token`.
   */
  issueSessionToken(sessionId: string): string;
  /** Revoke a per-session token. Subsequent frames bearing it are rejected. */
  revokeSessionToken(sessionId: string): void;
  /**
   * The bridge's token validator (boot-global + per-session registry). Remote
   * hook agents pass forwarded streams through `handleConnection` with this
   * validator so token issue/revoke applies identically to remote frames.
   */
  readonly validate: TokenValidator;
  /**
   * The event sink wired at bridge creation (session-manager dispatch).
   * Remote hook agents feed forwarded frames through this so local and
   * remote events share exactly one handling path.
   */
  readonly dispatchEvent: HookEventHandler;
  /** Tears down the listener and removes the POSIX socket file. Idempotent. */
  dispose(): Promise<void>;
}

function buildSocketPath(): string {
  // Named pipes live in the dedicated Windows namespace — no filesystem
  // permissions, but only processes on the same machine can connect. On
  // POSIX we land in the per-user temp dir; with default 0o700 mkdtemp
  // perms the socket is only reachable by the same user.
  if (process.platform === 'win32') {
    // Per-user pipe name so two users on the same box don't collide.
    const user = (process.env.USERNAME || 'user').replace(/[^A-Za-z0-9_-]/g, '_');
    return `\\\\.\\pipe\\tether-hooks-${user}-${process.pid}`;
  }
  return path.join(os.tmpdir(), `tether-hooks-${process.getuid?.() ?? 'u'}-${process.pid}.sock`);
}

/**
 * Start the hook bridge listener. Idempotent within a process — callers
 * should hold the returned handle for the lifetime of the app and call
 * `dispose()` on shutdown.
 *
 * The bridge accepts multiple concurrent client connections (one per active
 * hook firing). Each connection authenticates once with the token, then
 * pushes any number of event frames before disconnecting.
 */
export async function createHookBridge(onEvent: HookEventHandler): Promise<HookBridgeHandle> {
  const socketPath = buildSocketPath();
  const token = crypto.randomBytes(32).toString('hex');
  const tokens = new HookTokenRegistry(token);

  // Clean any stale POSIX socket from a previous unclean shutdown. Windows
  // named pipes are released by the OS when the process exits, so no-op.
  if (process.platform !== 'win32') {
    try { require('node:fs').unlinkSync(socketPath); } catch { /* not there */ }
  }

  const server = net.createServer();

  server.on('connection', (socket) => {
    // Delegate the full per-connection lifecycle (auth, framing, dispatch) to
    // the stream-agnostic handler. The registry's validator keeps the
    // boot-global token valid for every session and accepts per-session tokens
    // scoped to a matching session id.
    handleConnection(socket, onEvent, tokens.validate);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      // POSIX sockets inherit the process umask (typically 0644 → world-
      // readable, world-connectable). Tighten to 0600 so only the current
      // uid can dial — defense in depth on top of the token check.
      if (process.platform !== 'win32') {
        try { require('node:fs').chmodSync(socketPath, 0o600); }
        catch (err) { log.warn('Hook bridge: chmod 0600 failed', { error: (err as Error).message }); }
      }
      log.info('Hook bridge listening', { socketPath });
      resolve();
    });
  });

  let disposed = false;
  return {
    socketPath,
    token,
    issueSessionToken: (sessionId: string) => tokens.issueSessionToken(sessionId),
    revokeSessionToken: (sessionId: string) => tokens.revokeSessionToken(sessionId),
    validate: tokens.validate,
    dispatchEvent: onEvent,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (process.platform !== 'win32') {
        try { require('node:fs').unlinkSync(socketPath); } catch { /* already gone */ }
      }
      log.info('Hook bridge disposed');
    },
  };
}
