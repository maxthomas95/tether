import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHookBridge, type HookBridgeHandle, type HookEvent } from './hook-bridge';

const handles: HookBridgeHandle[] = [];

afterEach(async () => {
  for (const h of handles.splice(0)) {
    await h.dispose();
  }
});

async function startBridge(onEvent: (e: HookEvent) => void): Promise<HookBridgeHandle> {
  const h = await createHookBridge(onEvent);
  handles.push(h);
  return h;
}

function dialClient(socketPath: string): net.Socket {
  // net.connect accepts both Unix sockets and Windows named-pipe paths.
  return net.connect(socketPath);
}

function send(socket: net.Socket, frame: Record<string, unknown>): void {
  socket.write(JSON.stringify(frame) + '\n');
}

function readFrames(socket: net.Socket): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve) => {
    const frames: Array<Record<string, unknown>> = [];
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) frames.push(JSON.parse(line));
        nl = buf.indexOf('\n');
      }
    });
    socket.on('close', () => resolve(frames));
  });
}

describe('hook bridge', () => {
  it('rejects connections that send events before authenticating', async () => {
    const onEvent = vi.fn();
    const bridge = await startBridge(onEvent);

    const sock = dialClient(bridge.socketPath);
    const framesP = readFrames(sock);
    await new Promise<void>((r) => sock.once('connect', () => r()));
    send(sock, { id: '1', method: 'event', tetherSessionId: 'sess', type: 'idle_prompt' });

    const frames = await framesP;
    expect(frames).toHaveLength(1);
    expect(frames[0].error).toMatchObject({ code: 401 });
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('rejects bad tokens and accepts the real one', async () => {
    const onEvent = vi.fn();
    const bridge = await startBridge(onEvent);

    // Bad token first
    const badSock = dialClient(bridge.socketPath);
    const badFramesP = readFrames(badSock);
    await new Promise<void>((r) => badSock.once('connect', () => r()));
    send(badSock, { id: 'auth', method: 'authenticate', token: 'wrong-token-of-similar-length-padding-pad-pad-pad-pad-pad-pad-1234' });
    const badFrames = await badFramesP;
    expect(badFrames[0].error).toMatchObject({ code: 401 });

    // Good token next
    const goodSock = dialClient(bridge.socketPath);
    const goodFramesP = readFrames(goodSock);
    await new Promise<void>((r) => goodSock.once('connect', () => r()));
    send(goodSock, { id: 'auth', method: 'authenticate', token: bridge.token });
    send(goodSock, {
      id: '2',
      method: 'event',
      tetherSessionId: 'session-abc',
      type: 'permission_prompt',
      source: 'claude',
      payload: { notification_type: 'permission_prompt' },
    });
    goodSock.end();

    const goodFrames = await goodFramesP;
    expect(goodFrames[0].result).toEqual({ ok: true });
    expect(goodFrames[1].result).toEqual({ ok: true });
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0][0]).toEqual({
      tetherSessionId: 'session-abc',
      type: 'permission_prompt',
      source: 'claude',
      payload: { notification_type: 'permission_prompt' },
    });
  });

  it('rejects events missing required fields', async () => {
    const onEvent = vi.fn();
    const bridge = await startBridge(onEvent);

    const sock = dialClient(bridge.socketPath);
    const framesP = readFrames(sock);
    await new Promise<void>((r) => sock.once('connect', () => r()));
    send(sock, { id: 'auth', method: 'authenticate', token: bridge.token });
    send(sock, { id: '1', method: 'event' });
    send(sock, { id: '2', method: 'event', tetherSessionId: 'sess' });
    sock.end();

    const frames = await framesP;
    // [auth-ok, missing-fields, missing-type]
    expect(frames[0].result).toEqual({ ok: true });
    expect(frames[1].error).toMatchObject({ code: -32602 });
    expect(frames[2].error).toMatchObject({ code: -32602 });
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('dispose() releases the socket so a fresh bridge can bind at the same path', async () => {
    const first = await createHookBridge(() => {});
    const firstPath = first.socketPath;
    await first.dispose();

    // If dispose() didn't actually release the socket, the second listen()
    // would throw EADDRINUSE (POSIX) or fail with EADDRINUSE-equivalent on
    // Windows named pipes. Reaching this assertion at all proves cleanup.
    const second = await createHookBridge(() => {});
    handles.push(second);
    expect(second.socketPath).toBe(firstPath);
    expect(second.token).not.toBe(first.token);
  });
});
