import net from 'node:net';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHelmBridge, type HelmBridgeHandle } from './bridge';

const bridges: HelmBridgeHandle[] = [];
const clients: net.Socket[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.destroy(); for (const bridge of bridges.splice(0)) bridge.dispose(); });
async function setup() {
  const handler = vi.fn(async () => ({ ok: true }));
  const bridge = await createHelmBridge(crypto.randomUUID(), { ping: handler }); bridges.push(bridge);
  return { bridge, handler };
}
async function connect(bridge: HelmBridgeHandle) {
  const socket = net.connect(bridge.socketPath); clients.push(socket);
  const frames: Array<Record<string, unknown>> = []; let buffer = '';
  socket.on('data', data => {
    buffer += data.toString();
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) { frames.push(JSON.parse(buffer.slice(0, nl))); buffer = buffer.slice(nl + 1); }
  });
  await once(socket, 'connect');
  return { socket, frames, send: (frame: object) => socket.write(JSON.stringify(frame) + '\n') };
}
describe('Helm authentication and framing', () => {
  it('lets the real client authenticate while an unauthenticated connection is idle', async () => {
    const { bridge, handler } = await setup();
    const idle = await connect(bridge);
    const client = await connect(bridge);
    client.send({ id: 'a', method: 'authenticate', params: { token: bridge.token } });
    await vi.waitFor(() => expect(client.frames).toHaveLength(1));
    client.send({ id: 'p', method: 'ping' });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    idle.socket.destroy();
  });

  it('recovers after a bad first authentication and after an authenticated client disconnects', async () => {
    const { bridge } = await setup();
    const bad = await connect(bridge); const closed = once(bad.socket, 'close');
    bad.send({ id: 'a', method: 'authenticate', params: { token: 'é'.repeat(64) } });
    await closed;
    const good = await connect(bridge);
    good.send({ id: 'a', method: 'authenticate', params: { token: bridge.token } });
    await vi.waitFor(() => expect(good.frames[0]).toMatchObject({ result: { ok: true } }));
    good.socket.destroy(); await once(good.socket, 'close');
    const reconnect = await connect(bridge);
    reconnect.send({ id: 'a', method: 'authenticate', params: { token: bridge.token } });
    await vi.waitFor(() => expect(reconnect.frames[0]).toMatchObject({ result: { ok: true } }));
  });

  it('rejects oversized unauthenticated data without claiming the bridge', async () => {
    const { bridge, handler } = await setup();
    const client = await connect(bridge); const closed = once(client.socket, 'close');
    client.socket.write(Buffer.alloc(17 * 1024, 'x'));
    await closed; expect(handler).not.toHaveBeenCalled();
    const good = await connect(bridge);
    good.send({ id: 'a', method: 'authenticate', params: { token: bridge.token } });
    await vi.waitFor(() => expect(good.frames[0]).toMatchObject({ result: { ok: true } }));
  });

  it('rejects malformed params and inherited method names without dispatch', async () => {
    const { bridge, handler } = await setup(); const client = await connect(bridge);
    client.send({ id: 'a', method: 'authenticate', params: { token: bridge.token } });
    await vi.waitFor(() => expect(client.frames).toHaveLength(1));
    client.send({ id: 'p', method: 'toString' });
    await vi.waitFor(() => expect(client.frames[1]).toMatchObject({ error: { code: -32601 } }));
    const closed = once(client.socket, 'close'); client.send({ id: 'p', method: 'ping', params: [] });
    await closed; expect(handler).not.toHaveBeenCalled();
  });

  it('times out silent unauthenticated clients and disposes active sockets', async () => {
    const { bridge } = await setup(); const client = await connect(bridge);
    await once(client.socket, 'close');
    const active = await connect(bridge); const closed = once(active.socket, 'close');
    bridge.dispose(); await closed;
  }, 5000);
});
