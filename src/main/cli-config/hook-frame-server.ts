import crypto from 'node:crypto';
import type { Duplex } from 'node:stream';
import { createLogger } from '../logger';

const log = createLogger('hook-frame-server');

/**
 * Stream-agnostic core of the hook bridge. Given any duplex stream — a local
 * `net.Socket` today, an ssh2-forwarded channel tomorrow — it runs the same
 * line-framed protocol: one auth handshake, then any number of event frames.
 *
 * Splitting this out of the `net.Server` wrapper means a future remote
 * transport can forward a stream straight into `handleConnection` and serve
 * hook events identically, without re-implementing auth, framing, or the
 * byte caps. `createHookBridge` (hook-bridge.ts) stays a thin `net.Server`
 * shell that delegates each connection here.
 *
 * Protocol (one JSON object per `\n`-terminated line):
 *   First frame  : { id: "auth", method: "authenticate", token: "<hex>", tetherSessionId? }
 *   Subsequent   : { id, method: "event", tetherSessionId, type, payload? }
 * Bad/missing token → error frame + close. Unknown method → error frame.
 */

export type HookEventType =
  | 'permission_prompt'
  | 'idle_prompt'
  | 'turn_complete'
  | 'auth_success'
  | 'elicitation_dialog'
  | 'elicitation_complete'
  | 'elicitation_response';

export interface HookEvent {
  tetherSessionId: string;
  type: HookEventType;
  /** Source CLI tool that emitted the event. Used for logging/diagnostics. */
  source: 'claude' | 'codex' | 'unknown';
  /** Raw payload from the CLI, preserved for downstream consumers if needed. */
  payload?: Record<string, unknown>;
}

export type HookEventHandler = (event: HookEvent) => void;

/**
 * Validates a supplied token against an optional Tether session id. Returns
 * true to accept the handshake. Implementations MUST use a constant-time
 * comparison against any equal-length candidate to avoid leaking the secret
 * via timing — see `defaultTokenValidator`.
 */
export type TokenValidator = (token: string, tetherSessionId: string) => boolean;

// Hard cap on un-authenticated bytes — defends against a co-resident process
// (or a hostile forwarded channel) flooding the listener before the token
// check. Matches the original net.Server limit byte-for-byte.
const PRE_AUTH_LIMIT = 16 * 1024;

// Hard timeout for the auth handshake; anyone who connects without
// authenticating within 2s gets dropped, freeing the connection slot.
const AUTH_TIMEOUT_MS = 2000;

/**
 * Constant-time compare on equal-length buffers; bail early on length
 * mismatch (the only safe shortcut — lengths aren't secret). Returns false
 * for any length difference so we never throw inside `timingSafeEqual`.
 */
export function constantTimeEqual(supplied: string, expected: string): boolean {
  return (
    supplied.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
  );
}

/**
 * Per-session token registry. Issued tokens authorize hook frames carrying a
 * matching `tetherSessionId`; the boot-global token (passed at construction)
 * stays valid for every session so local sessions — which all share the one
 * env-injected token — keep working unchanged.
 *
 * Revoked or never-issued per-session tokens are rejected. This is the seam a
 * future remote transport uses to scope a forwarded stream's credential to a
 * single session.
 */
export class HookTokenRegistry {
  private readonly sessionTokens = new Map<string, string>();

  /**
   * @param bootToken Process-wide secret minted once per launch. Accepted for
   *   any session id (local sessions all present this one token).
   */
  constructor(private readonly bootToken: string) {}

  /** Mint and register a per-session token. Idempotent per session id. */
  issueSessionToken(sessionId: string): string {
    const existing = this.sessionTokens.get(sessionId);
    if (existing) return existing;
    const token = crypto.randomBytes(32).toString('hex');
    this.sessionTokens.set(sessionId, token);
    return token;
  }

  /** Drop a session's token. Subsequent frames bearing it are rejected. */
  revokeSessionToken(sessionId: string): void {
    this.sessionTokens.delete(sessionId);
  }

  /**
   * Accept the boot-global token for any session, or a per-session token that
   * matches the supplied session id. Constant-time against each candidate.
   */
  validate: TokenValidator = (token, tetherSessionId) => {
    if (constantTimeEqual(token, this.bootToken)) return true;
    if (!tetherSessionId) return false;
    const sessionToken = this.sessionTokens.get(tetherSessionId);
    return typeof sessionToken === 'string' && constantTimeEqual(token, sessionToken);
  };
}

/**
 * Build a validator that only accepts the single boot-global token, ignoring
 * session scoping. Equivalent to the original bridge's behavior.
 */
export function defaultTokenValidator(bootToken: string): TokenValidator {
  return (token) => constantTimeEqual(token, bootToken);
}

/**
 * Serve one duplex connection: auth handshake, line framing, event dispatch.
 * Stream-agnostic — works over a `net.Socket` or any other `Duplex`.
 *
 * @param duplex      The connection stream.
 * @param onEvent     Invoked once per validated event frame.
 * @param validate    Token validator. The auth frame may carry a
 *                    `tetherSessionId` so per-session tokens can be scoped.
 */
export function handleConnection(
  duplex: Duplex,
  onEvent: HookEventHandler,
  validate: TokenValidator,
): void {
  log.info('Hook frame server: client connected');
  let authed = false;
  let buffer = '';
  let preAuthBytes = 0;

  const authTimer = setTimeout(() => {
    if (!authed) {
      log.warn('Hook frame server: auth timeout, closing connection');
      duplex.destroy();
    }
  }, AUTH_TIMEOUT_MS);

  const writeFrame = (frame: Record<string, unknown>) => {
    try { duplex.write(JSON.stringify(frame) + '\n'); }
    catch { /* peer gone */ }
  };

  const handleLine = (raw: string) => {
    let req: Record<string, unknown>;
    try { req = JSON.parse(raw); }
    catch { log.warn('Hook frame server: malformed JSON'); duplex.destroy(); return; }

    const id = typeof req.id === 'string' ? req.id : '';
    const method = typeof req.method === 'string' ? req.method : '';

    if (!authed) {
      if (method !== 'authenticate') {
        writeFrame({ id, error: { code: 401, message: 'Must authenticate first' } });
        duplex.destroy();
        return;
      }
      const supplied = typeof req.token === 'string' ? req.token : '';
      // The auth frame MAY scope the token to a session; absent (the local
      // case) the boot-global token is accepted for any session.
      const authSessionId = typeof req.tetherSessionId === 'string' ? req.tetherSessionId : '';
      if (!validate(supplied, authSessionId)) {
        writeFrame({ id, error: { code: 401, message: 'Invalid token' } });
        duplex.destroy();
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
      log.info('Hook frame server: event delivered', { tetherSessionId, type, source });
      writeFrame({ id, result: { ok: true } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('Hook frame server handler threw', { method, error: message });
      writeFrame({ id, error: { code: -32000, message } });
    }
  };

  duplex.on('data', (chunk: Buffer) => {
    if (!authed) {
      preAuthBytes += chunk.length;
      if (preAuthBytes > PRE_AUTH_LIMIT) {
        log.warn('Hook frame server: pre-auth byte cap exceeded, closing');
        duplex.destroy();
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

  duplex.on('error', (err: Error) => {
    log.warn('Hook frame server stream error', { error: err.message });
  });

  duplex.on('close', () => {
    clearTimeout(authTimer);
  });
}
