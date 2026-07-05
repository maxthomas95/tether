import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { createHookBridge, type HookBridgeHandle, type HookEvent } from './hook-bridge';
import { handleConnection, defaultTokenValidator } from './hook-frame-server';

const helperPath = path.resolve(__dirname, '..', '..', '..', 'cli-tools', 'tether-cli-hook', 'index.js');

const handles: HookBridgeHandle[] = [];

afterEach(async () => {
  for (const h of handles.splice(0)) {
    await h.dispose();
  }
});

interface HelperResult {
  exitCode: number | null;
  events: HookEvent[];
}

/**
 * Spawn the helper, wait for it to exit, return the (possibly empty) list of
 * events the bridge received from it.
 */
function runHelper(args: {
  socket: string;
  token: string;
  sessionId: string;
  mode: '--claude' | '--codex';
  payload: unknown;
  events: HookEvent[];
}): Promise<HelperResult> {
  // NOSONAR(typescript:S4036)
  const child = spawn(process.execPath, [helperPath, args.mode, ...(args.mode === '--codex' ? [JSON.stringify(args.payload)] : [])], {
    env: {
      ...process.env,
      TETHER_HOOK_SOCKET: args.socket,
      TETHER_HOOK_TOKEN: args.token,
      TETHER_SESSION_ID: args.sessionId,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (args.mode === '--claude') {
    child.stdin.write(JSON.stringify(args.payload));
    child.stdin.end();
  } else {
    child.stdin.end();
  }
  return new Promise<HelperResult>((resolve) => {
    child.on('exit', (code) => {
      // Tiny grace period so the bridge handler runs to completion before
      // we snapshot the captured events array.
      setTimeout(() => resolve({ exitCode: code, events: args.events.slice() }), 50);
    });
  });
}

describe('tether-cli-hook helper (end-to-end against the bridge)', () => {
  it('classifies Claude Notification(permission_prompt) and posts it', async () => {
    const events: HookEvent[] = [];
    const bridge = await createHookBridge((e) => events.push(e));
    handles.push(bridge);

    const result = await runHelper({
      socket: bridge.socketPath,
      token: bridge.token,
      sessionId: 'session-claude-1',
      mode: '--claude',
      payload: {
        session_id: 'claude-uuid',
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        cwd: '/some/dir',
      },
      events,
    });

    expect(result.exitCode).toBe(0);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      tetherSessionId: 'session-claude-1',
      type: 'permission_prompt',
      source: 'claude',
    });
  });

  it('classifies Claude Stop as turn_complete', async () => {
    const events: HookEvent[] = [];
    const bridge = await createHookBridge((e) => events.push(e));
    handles.push(bridge);

    const result = await runHelper({
      socket: bridge.socketPath,
      token: bridge.token,
      sessionId: 'session-claude-2',
      mode: '--claude',
      payload: { session_id: 'x', hook_event_name: 'Stop' },
      events,
    });

    expect(result.exitCode).toBe(0);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].type).toBe('turn_complete');
  });

  it('classifies Codex agent-turn-complete', async () => {
    const events: HookEvent[] = [];
    const bridge = await createHookBridge((e) => events.push(e));
    handles.push(bridge);

    const result = await runHelper({
      socket: bridge.socketPath,
      token: bridge.token,
      sessionId: 'session-codex-1',
      mode: '--codex',
      payload: { type: 'agent-turn-complete', 'turn-id': 'abc', cwd: '/x' },
      events,
    });

    expect(result.exitCode).toBe(0);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      tetherSessionId: 'session-codex-1',
      type: 'turn_complete',
      source: 'codex',
    });
  });

  it('silently exits 0 when env is not wired (degrades cleanly)', async () => {
    // No bridge: helper should simply do nothing if it can't even know the
    // socket path. This keeps the user's CLI working if Tether isn't running.
    const child = spawn(process.execPath, [helperPath, '--claude'], {
      // NOSONAR(typescript:S4036)
      env: { ...process.env, TETHER_HOOK_SOCKET: '', TETHER_HOOK_TOKEN: '', TETHER_SESSION_ID: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.write('{"hook_event_name":"Stop"}');
    child.stdin.end();
    const code = await new Promise<number | null>((r) => child.on('exit', r));
    expect(code).toBe(0);
  });

  it('silently exits 0 when the bridge is unreachable', async () => {
    const events: HookEvent[] = [];
    // Point the helper at a path that doesn't exist. Should time out quickly
    // (helper has a 1s cap) without faulting.
    const fakeSocket = process.platform === 'win32'
      ? String.raw`\\.\pipe\tether-hooks-nonexistent-test`
      : path.join(process.cwd(), 'tether-hooks-nonexistent-test.sock');
    const result = await runHelper({
      socket: fakeSocket,
      token: 'irrelevant',
      sessionId: 'session-x',
      mode: '--claude',
      payload: { hook_event_name: 'Stop' },
      events,
    });
    expect(result.exitCode).toBe(0);
    expect(result.events).toHaveLength(0);
  });

  it('does not deliver events when the token is wrong', async () => {
    const events: HookEvent[] = [];
    const bridge = await createHookBridge((e) => events.push(e));
    handles.push(bridge);

    const result = await runHelper({
      socket: bridge.socketPath,
      token: 'definitely-not-the-real-token-of-correct-shape-padding-padding-x',
      sessionId: 'session-y',
      mode: '--claude',
      payload: { hook_event_name: 'Stop' },
      events,
    });
    expect(result.exitCode).toBe(0);
    expect(result.events).toHaveLength(0);
  });
});

/**
 * Remote-session shape: the launch line carries only TETHER_HOOK_ENV_FILE; the
 * socket, a per-session token, and the session id live in a 0600 file.
 */
function runHelperWithEnvFile(args: {
  envFile: Record<string, string>;
  mode: '--claude' | '--codex';
  payload: unknown;
  events: HookEvent[];
}): Promise<HelperResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-hook-envfile-'));
  const envFilePath = path.join(dir, 's-test.env');
  fs.writeFileSync(
    envFilePath,
    Object.entries(args.envFile).map(([k, v]) => `${k}=${v}`).join('\n') + '\n',
  );
  // NOSONAR(typescript:S4036)
  const child = spawn(process.execPath, [helperPath, args.mode, ...(args.mode === '--codex' ? [JSON.stringify(args.payload)] : [])], {
    env: {
      ...process.env,
      TETHER_HOOK_SOCKET: '',
      TETHER_HOOK_TOKEN: '',
      TETHER_SESSION_ID: '',
      TETHER_HOOK_ENV_FILE: envFilePath,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (args.mode === '--claude') {
    child.stdin.write(JSON.stringify(args.payload));
  }
  child.stdin.end();
  return new Promise<HelperResult>((resolve) => {
    child.on('exit', (code) => {
      setTimeout(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        resolve({ exitCode: code, events: args.events.slice() });
      }, 50);
    });
  });
}

describe('tether-cli-hook helper (remote env-file fallback)', () => {
  it('reads socket/token/session id from TETHER_HOOK_ENV_FILE and authenticates with a per-session token', async () => {
    const events: HookEvent[] = [];
    const bridge = await createHookBridge((e) => events.push(e));
    handles.push(bridge);
    const sessionToken = bridge.issueSessionToken('remote-sess-1');

    const result = await runHelperWithEnvFile({
      envFile: {
        TETHER_HOOK_SOCKET: bridge.socketPath,
        TETHER_HOOK_TOKEN: sessionToken,
        TETHER_SESSION_ID: 'remote-sess-1',
      },
      mode: '--claude',
      payload: { hook_event_name: 'Notification', notification_type: 'permission_prompt' },
      events,
    });

    expect(result.exitCode).toBe(0);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      tetherSessionId: 'remote-sess-1',
      type: 'permission_prompt',
      source: 'claude',
    });
  });

  it('rejects a per-session token after revocation (orphan helper cannot post)', async () => {
    const events: HookEvent[] = [];
    const bridge = await createHookBridge((e) => events.push(e));
    handles.push(bridge);
    const sessionToken = bridge.issueSessionToken('remote-sess-2');
    bridge.revokeSessionToken('remote-sess-2');

    const result = await runHelperWithEnvFile({
      envFile: {
        TETHER_HOOK_SOCKET: bridge.socketPath,
        TETHER_HOOK_TOKEN: sessionToken,
        TETHER_SESSION_ID: 'remote-sess-2',
      },
      mode: '--claude',
      payload: { hook_event_name: 'Stop' },
      events,
    });

    expect(result.exitCode).toBe(0);
    expect(result.events).toHaveLength(0);
  });

  it('rejects a per-session token presented for a different session id', async () => {
    const events: HookEvent[] = [];
    const bridge = await createHookBridge((e) => events.push(e));
    handles.push(bridge);
    const sessionToken = bridge.issueSessionToken('remote-sess-3');

    const result = await runHelperWithEnvFile({
      envFile: {
        TETHER_HOOK_SOCKET: bridge.socketPath,
        TETHER_HOOK_TOKEN: sessionToken,
        TETHER_SESSION_ID: 'someone-elses-session',
      },
      mode: '--claude',
      payload: { hook_event_name: 'Stop' },
      events,
    });

    expect(result.exitCode).toBe(0);
    expect(result.events).toHaveLength(0);
  });

  it('dials tcp://127.0.0.1:<port> socket values (TCP-forward fallback)', async () => {
    const events: HookEvent[] = [];
    const token = 'tcp-fallback-test-token';
    const server = net.createServer((sock) => {
      handleConnection(sock, (e) => events.push(e), defaultTokenValidator(token));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;

    try {
      const result = await runHelperWithEnvFile({
        envFile: {
          TETHER_HOOK_SOCKET: `tcp://127.0.0.1:${port}`,
          TETHER_HOOK_TOKEN: token,
          TETHER_SESSION_ID: 'remote-sess-tcp',
        },
        mode: '--codex',
        payload: { type: 'agent-turn-complete' },
        events,
      });

      expect(result.exitCode).toBe(0);
      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toMatchObject({
        tetherSessionId: 'remote-sess-tcp',
        type: 'turn_complete',
        source: 'codex',
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
