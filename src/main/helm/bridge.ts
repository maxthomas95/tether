import net from 'node:net';
import crypto from 'node:crypto';
import { createLogger } from '../logger';

const log = createLogger('helm-bridge');

/**
 * JSON-RPC-ish wire protocol over a named pipe / Unix socket.
 *
 * Frame: one JSON object per line (`\n`-terminated). Every request carries an
 * `id`; the bridge echoes the same `id` in the response so the caller can
 * correlate concurrent calls. Over a per-session bridge the MCP server is
 * effectively single-threaded so this is belt-and-suspenders, but it keeps the
 * protocol trivially debuggable.
 *
 * The FIRST frame from the client MUST be:
 *   {"id":"auth","method":"authenticate","params":{"token":"<hex>"}}
 *
 * On bad/missing token the bridge writes an error frame and closes the socket.
 * Subsequent frames are dispatched to the caller-supplied handlers.
 */

export interface HelmRpcRequest {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface HelmRpcError {
  code: number;
  message: string;
}

export interface HelmRpcResponse {
  id: string;
  result?: unknown;
  error?: HelmRpcError;
}

/**
 * Handler registry for v0. Each entry takes validated params and returns a
 * plain JSON result (or throws to produce an error frame). The bridge does no
 * schema checks — handlers are expected to cast/validate their own params.
 */
export interface HelmBridgeHandlers {
  spawn_session(params: Record<string, unknown>): Promise<unknown>;
}

export interface HelmBridgeHandle {
  /** Platform-specific transport address the MCP server should dial. */
  readonly socketPath: string;
  /** Random per-session secret the MCP server must present to authenticate. */
  readonly token: string;
  /** Tears down the listening socket. Idempotent. */
  dispose(): void;
}

function buildSocketPath(sessionId: string): string {
  // Named pipes on Windows live in a dedicated filesystem namespace. On
  // POSIX, fall back to a per-session file in the OS temp dir — 104-byte
  // socket path limit on macOS is avoided because sessionId is a UUID (36ch)
  // and `/tmp/tether-helm-<uuid>.sock` comfortably fits.
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\tether-helm-${sessionId}`;
  }
  const os = require('node:os');
  const path = require('node:path');
  return path.join(os.tmpdir(), `tether-helm-${sessionId}.sock`);
}

/**
 * Start a per-session bridge. The returned handle exposes the address + token
 * that the spawned MCP server needs in its environment. The bridge listens
 * until `dispose()` is called (typically from the session's exit/remove path).
 *
 * Only one client connection is honored — second connections are closed
 * immediately. This matches how the tether-helm MCP server operates: it dials
 * once at startup and holds the connection for the session's lifetime.
 */
export async function createHelmBridge(
  sessionId: string,
  handlers: HelmBridgeHandlers,
): Promise<HelmBridgeHandle> {
  const socketPath = buildSocketPath(sessionId);
  const token = crypto.randomBytes(32).toString('hex');

  // On POSIX a stale socket file will make listen() fail with EADDRINUSE even
  // if the old server is dead. Best-effort remove; Windows pipes don't leak.
  if (process.platform !== 'win32') {
    try { require('node:fs').unlinkSync(socketPath); } catch { /* not there */ }
  }

  const server = net.createServer();
  let claimed = false;

  server.on('connection', (socket) => {
    if (claimed) {
      log.warn('Rejecting second connection to helm bridge', { sessionId });
      socket.destroy();
      return;
    }
    claimed = true;
    log.info('Helm bridge client connected', { sessionId });

    let authed = false;
    let buffer = '';

    const writeFrame = (frame: HelmRpcResponse) => {
      try {
        socket.write(JSON.stringify(frame) + '\n');
      } catch (err) {
        log.warn('Failed to write bridge frame', { sessionId, error: err instanceof Error ? err.message : String(err) });
      }
    };

    const handleFrame = async (raw: string) => {
      let req: HelmRpcRequest;
      try {
        req = JSON.parse(raw);
      } catch {
        log.warn('Helm bridge: malformed JSON frame, closing', { sessionId });
        socket.destroy();
        return;
      }
      if (!req || typeof req.id !== 'string' || typeof req.method !== 'string') {
        log.warn('Helm bridge: missing id/method, closing', { sessionId });
        socket.destroy();
        return;
      }

      // Authentication must be the first frame. Reject everything else until
      // the token checks out — this prevents a co-resident process from
      // piggybacking the named pipe before the real MCP server connects.
      if (!authed) {
        if (req.method !== 'authenticate') {
          writeFrame({ id: req.id, error: { code: 401, message: 'Must authenticate first' } });
          socket.destroy();
          return;
        }
        const supplied = (req.params as { token?: unknown } | undefined)?.token;
        if (typeof supplied !== 'string' || supplied !== token) {
          writeFrame({ id: req.id, error: { code: 401, message: 'Invalid token' } });
          socket.destroy();
          return;
        }
        authed = true;
        writeFrame({ id: req.id, result: { ok: true } });
        return;
      }

      try {
        switch (req.method) {
          case 'spawn_session': {
            const result = await handlers.spawn_session(req.params || {});
            writeFrame({ id: req.id, result });
            break;
          }
          default:
            writeFrame({ id: req.id, error: { code: -32601, message: `Unknown method: ${req.method}` } });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn('Helm bridge handler threw', { sessionId, method: req.method, error: message });
        writeFrame({ id: req.id, error: { code: -32000, message } });
      }
    };

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      // Dispatch every complete line; keep the trailing partial frame in buffer.
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) void handleFrame(line);
        nl = buffer.indexOf('\n');
      }
    });

    socket.on('error', (err) => {
      log.warn('Helm bridge socket error', { sessionId, error: err.message });
    });

    socket.on('close', () => {
      log.info('Helm bridge client disconnected', { sessionId });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      log.info('Helm bridge listening', { sessionId, socketPath });
      resolve();
    });
  });

  return {
    socketPath,
    token,
    dispose() {
      try { server.close(); } catch { /* already closed */ }
      if (process.platform !== 'win32') {
        try { require('node:fs').unlinkSync(socketPath); } catch { /* already gone */ }
      }
    },
  };
}
