import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createLogger } from '../logger';

const log = createLogger('hook-bridge');

/**
 * Long-lived, process-wide socket that receives waiting-signal events from
 * CLI hook processes (Claude `Notification`/`Stop`, Codex `notify`). One
 * listener serves every session — sessions are demultiplexed by the
 * `tetherSessionId` field on each frame, which we inject into the CLI
 * process env at spawn time and the hook helper passes through to us.
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

export type HookEventType =
  | 'permission_prompt'
  | 'idle_prompt'
  | 'turn_complete'
  | 'auth_success'
  | 'elicitation_dialog';

export interface HookEvent {
  tetherSessionId: string;
  type: HookEventType;
  /** Source CLI tool that emitted the event. Used for logging/diagnostics. */
  source: 'claude' | 'codex' | 'unknown';
  /** Raw payload from the CLI, preserved for downstream consumers if needed. */
  payload?: Record<string, unknown>;
}

export type HookEventHandler = (event: HookEvent) => void;

export interface HookBridgeHandle {
  /** Address the hook helper dials. Passed to spawned CLIs via TETHER_HOOK_SOCKET. */
  readonly socketPath: string;
  /** Random per-boot secret the hook helper must present. Passed via TETHER_HOOK_TOKEN. */
  readonly token: string;
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

  // Clean any stale POSIX socket from a previous unclean shutdown. Windows
  // named pipes are released by the OS when the process exits, so no-op.
  if (process.platform !== 'win32') {
    try { require('node:fs').unlinkSync(socketPath); } catch { /* not there */ }
  }

  const server = net.createServer();

  server.on('connection', (socket) => {
    log.info('Hook bridge: client connected');
    let authed = false;
    let buffer = '';
    // Hard cap on un-authenticated bytes — defends against a co-resident
    // process flooding the listener before the token check.
    const PRE_AUTH_LIMIT = 16 * 1024;
    let preAuthBytes = 0;

    // Hard timeout for the auth handshake; anyone who connects without
    // authenticating within 2s gets dropped. Prevents tied-up connection
    // slots from a stalled or hostile client.
    const authTimer = setTimeout(() => {
      if (!authed) {
        log.warn('Hook bridge: auth timeout, closing connection');
        socket.destroy();
      }
    }, 2000);

    const writeFrame = (frame: Record<string, unknown>) => {
      try { socket.write(JSON.stringify(frame) + '\n'); }
      catch { /* peer gone */ }
    };

    const handleLine = (raw: string) => {
      let req: Record<string, unknown>;
      try { req = JSON.parse(raw); }
      catch { log.warn('Hook bridge: malformed JSON'); socket.destroy(); return; }

      const id = typeof req.id === 'string' ? req.id : '';
      const method = typeof req.method === 'string' ? req.method : '';

      if (!authed) {
        if (method !== 'authenticate') {
          writeFrame({ id, error: { code: 401, message: 'Must authenticate first' } });
          socket.destroy();
          return;
        }
        const supplied = typeof req.token === 'string' ? req.token : '';
        // Constant-time compare on equal-length buffers; bail early on
        // length mismatch (the only safe shortcut — lengths aren't secret).
        const ok = supplied.length === token.length &&
          crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
        if (!ok) {
          writeFrame({ id, error: { code: 401, message: 'Invalid token' } });
          socket.destroy();
          return;
        }
        authed = true;
        clearTimeout(authTimer);
        writeFrame({ id, result: { ok: true } });
        return;
      }

      if (method !== 'event') {
        writeFrame({ id, error: { code: -32601, message: `Unknown method: ${method}` } });
        return;
      }
      const tetherSessionId = typeof req.tetherSessionId === 'string' ? req.tetherSessionId : '';
      const type = typeof req.type === 'string' ? req.type : '';
      if (!tetherSessionId || !type) {
        writeFrame({ id, error: { code: -32602, message: 'tetherSessionId and type are required' } });
        return;
      }
      const source = req.source === 'claude' || req.source === 'codex' ? req.source : 'unknown';
      const payload = typeof req.payload === 'object' && req.payload !== null
        ? req.payload as Record<string, unknown>
        : undefined;
      try {
        onEvent({ tetherSessionId, type: type as HookEventType, source, payload });
        log.info('Hook bridge: event delivered', { tetherSessionId, type, source });
        writeFrame({ id, result: { ok: true } });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn('Hook bridge handler threw', { method, error: message });
        writeFrame({ id, error: { code: -32000, message } });
      }
    };

    socket.on('data', (chunk) => {
      if (!authed) {
        preAuthBytes += chunk.length;
        if (preAuthBytes > PRE_AUTH_LIMIT) {
          log.warn('Hook bridge: pre-auth byte cap exceeded, closing');
          socket.destroy();
          return;
        }
      }
      buffer += chunk.toString('utf8');
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) handleLine(line);
        nl = buffer.indexOf('\n');
      }
    });

    socket.on('error', (err) => {
      log.warn('Hook bridge socket error', { error: err.message });
    });

    socket.on('close', () => {
      clearTimeout(authTimer);
    });
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
