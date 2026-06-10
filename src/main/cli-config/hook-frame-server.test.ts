import { Duplex } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  handleConnection,
  HookTokenRegistry,
  constantTimeEqual,
  defaultTokenValidator,
  type HookEvent,
  type TokenValidator,
} from './hook-frame-server';

/**
 * In-memory duplex pair. The "server side" is what we hand to
 * `handleConnection`; the "client" helpers push frames into it and collect the
 * frames written back out — no real socket, no listening port.
 */
class FakeDuplex extends Duplex {
  /** Frames the server wrote back (parsed from the newline-framed stream). */
  readonly outFrames: Array<Record<string, unknown>> = [];
  destroyed_ = false;
  private outBuf = '';

  // The server only writes back; nothing to pull on demand.
  _read(): void { /* no-op */ }

  _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.outBuf += chunk.toString('utf8');
    let nl = this.outBuf.indexOf('\n');
    while (nl !== -1) {
      const line = this.outBuf.slice(0, nl).trim();
      this.outBuf = this.outBuf.slice(nl + 1);
      if (line) this.outFrames.push(JSON.parse(line));
      nl = this.outBuf.indexOf('\n');
    }
    cb();
  }

  override destroy(err?: Error): this {
    this.destroyed_ = true;
    return super.destroy(err);
  }

  /**
   * Simulate the client sending one JSON frame. We emit 'data' synchronously
   * (rather than push() through the readable buffer, which would defer to a
   * later tick) so each test reads the server's reply right after sending —
   * handleConnection only relies on the 'data'/'error'/'close' events.
   */
  clientSend(frame: Record<string, unknown>): void {
    this.emit('data', Buffer.from(JSON.stringify(frame) + '\n', 'utf8'));
  }

  /** Simulate raw bytes from the client (for the malformed/flood cases). */
  clientRaw(data: string): void {
    this.emit('data', Buffer.from(data, 'utf8'));
  }
}

/** Run a synchronous client script against a fresh server connection. */
function serve(validate: TokenValidator, onEvent: (e: HookEvent) => void): FakeDuplex {
  const duplex = new FakeDuplex();
  handleConnection(duplex, onEvent, validate);
  return duplex;
}

const BOOT_TOKEN = 'boot-token-fixed-length-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('constantTimeEqual', () => {
  it('returns true only for an exact match', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
  });

  it('returns false (never throws) on length mismatch', () => {
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', 'x')).toBe(false);
  });
});

describe('handleConnection auth', () => {
  it('rejects an event sent before authenticating', () => {
    const onEvent = vi.fn();
    const d = serve(defaultTokenValidator(BOOT_TOKEN), onEvent);
    d.clientSend({ id: '1', method: 'event', tetherSessionId: 'sess', type: 'idle_prompt' });
    expect(d.outFrames).toHaveLength(1);
    expect(d.outFrames[0].error).toMatchObject({ code: 401 });
    expect(d.destroyed_).toBe(true);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('rejects a bad token and closes', () => {
    const d = serve(defaultTokenValidator(BOOT_TOKEN), vi.fn());
    d.clientSend({ id: 'auth', method: 'authenticate', token: 'nope' });
    expect(d.outFrames[0].error).toMatchObject({ code: 401 });
    expect(d.destroyed_).toBe(true);
  });

  it('accepts the boot token then delivers an event', () => {
    const onEvent = vi.fn();
    const d = serve(defaultTokenValidator(BOOT_TOKEN), onEvent);
    d.clientSend({ id: 'auth', method: 'authenticate', token: BOOT_TOKEN });
    d.clientSend({
      id: '2', method: 'event', tetherSessionId: 'session-abc',
      type: 'permission_prompt', source: 'claude', payload: { k: 'v' },
    });
    expect(d.outFrames[0].result).toEqual({ ok: true });
    expect(d.outFrames[1].result).toEqual({ ok: true });
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0][0]).toEqual({
      tetherSessionId: 'session-abc',
      type: 'permission_prompt',
      source: 'claude',
      payload: { k: 'v' },
    });
  });

  it('rejects events missing required fields after auth', () => {
    const onEvent = vi.fn();
    const d = serve(defaultTokenValidator(BOOT_TOKEN), onEvent);
    d.clientSend({ id: 'auth', method: 'authenticate', token: BOOT_TOKEN });
    d.clientSend({ id: '1', method: 'event' });
    d.clientSend({ id: '2', method: 'event', tetherSessionId: 'sess' });
    expect(d.outFrames[0].result).toEqual({ ok: true });
    expect(d.outFrames[1].error).toMatchObject({ code: -32602 });
    expect(d.outFrames[2].error).toMatchObject({ code: -32602 });
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('destroys the connection on malformed JSON', () => {
    const d = serve(defaultTokenValidator(BOOT_TOKEN), vi.fn());
    d.clientRaw('{ not json\n');
    expect(d.destroyed_).toBe(true);
  });

  it('rejects an unknown method after auth without closing', () => {
    const d = serve(defaultTokenValidator(BOOT_TOKEN), vi.fn());
    d.clientSend({ id: 'auth', method: 'authenticate', token: BOOT_TOKEN });
    d.clientSend({ id: '3', method: 'frobnicate' });
    expect(d.outFrames[1].error).toMatchObject({ code: -32601 });
    expect(d.destroyed_).toBe(false);
  });
});

describe('HookTokenRegistry', () => {
  it('the boot token authenticates any session id', () => {
    const reg = new HookTokenRegistry(BOOT_TOKEN);
    expect(reg.validate(BOOT_TOKEN, 'any-session')).toBe(true);
    expect(reg.validate(BOOT_TOKEN, '')).toBe(true);
  });

  it('issues a per-session token that is only valid for its session', () => {
    const reg = new HookTokenRegistry(BOOT_TOKEN);
    const t = reg.issueSessionToken('sess-1');
    expect(t).toHaveLength(64); // 32 random bytes hex-encoded
    expect(reg.validate(t, 'sess-1')).toBe(true);
    // Wrong session id → rejected even though the token itself is known.
    expect(reg.validate(t, 'sess-2')).toBe(false);
    // No session id → rejected for a per-session token.
    expect(reg.validate(t, '')).toBe(false);
  });

  it('issueSessionToken is idempotent per session', () => {
    const reg = new HookTokenRegistry(BOOT_TOKEN);
    expect(reg.issueSessionToken('sess-1')).toBe(reg.issueSessionToken('sess-1'));
  });

  it('revoked per-session tokens are rejected; boot token still valid', () => {
    const reg = new HookTokenRegistry(BOOT_TOKEN);
    const t = reg.issueSessionToken('sess-1');
    reg.revokeSessionToken('sess-1');
    expect(reg.validate(t, 'sess-1')).toBe(false);
    // Boot-global token is untouched by per-session revocation.
    expect(reg.validate(BOOT_TOKEN, 'sess-1')).toBe(true);
  });

  it('an unknown per-session token is rejected', () => {
    const reg = new HookTokenRegistry(BOOT_TOKEN);
    expect(reg.validate('never-issued-token-of-some-length-padpadpadpadpadpad', 'sess-x')).toBe(false);
  });

  it('end-to-end: registry validator accepts a scoped event over a connection', () => {
    const reg = new HookTokenRegistry(BOOT_TOKEN);
    const token = reg.issueSessionToken('sess-1');
    const onEvent = vi.fn();
    const d = serve(reg.validate, onEvent);
    // Auth frame carries the session id so the per-session token can be scoped.
    d.clientSend({ id: 'auth', method: 'authenticate', token, tetherSessionId: 'sess-1' });
    d.clientSend({ id: '1', method: 'event', tetherSessionId: 'sess-1', type: 'turn_complete', source: 'codex' });
    expect(d.outFrames[0].result).toEqual({ ok: true });
    expect(onEvent).toHaveBeenCalledTimes(1);

    // A revoked token no longer authenticates a fresh connection.
    reg.revokeSessionToken('sess-1');
    const d2 = serve(reg.validate, vi.fn());
    d2.clientSend({ id: 'auth', method: 'authenticate', token, tetherSessionId: 'sess-1' });
    expect(d2.outFrames[0].error).toMatchObject({ code: 401 });
    expect(d2.destroyed_).toBe(true);
  });
});
