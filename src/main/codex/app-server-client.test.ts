import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { callCodexAppServer, resetCodexAppServerClientForTests } from './app-server-client';

function frame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf-8');
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'),
    body,
  ]);
}

function makeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    pid: number | undefined;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = undefined;
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  return child;
}

describe('codex app-server client', () => {
  beforeEach(() => {
    resetCodexAppServerClientForTests();
  });

  it('initializes, sends initialized, then reads allowlisted methods', async () => {
    const child = makeChild();
    const spawnImpl = vi.fn(() => child);
    const writes: string[] = [];
    child.stdin.on('data', chunk => writes.push(String(chunk)));

    const promise = callCodexAppServer([
      { method: 'account/read', params: { refreshToken: false } },
    ], { spawnImpl: spawnImpl as never });

    child.stdout.write(frame({ id: 1, result: { codexHome: 'x', platformFamily: 'windows', platformOs: 'windows', userAgent: 'codex' } }));
    await vi.waitFor(() => expect(writes.join('')).toContain('"method":"initialized"'));
    expect(writes.join('')).toContain('"method":"account/read"');
    expect(writes.join('')).toContain('"refreshToken":false');

    child.stdout.write(frame({ id: 2, result: { account: { type: 'apiKey' }, requiresOpenaiAuth: false } }));
    await expect(promise).resolves.toEqual([
      { method: 'account/read', ok: true, result: { account: { type: 'apiKey' }, requiresOpenaiAuth: false } },
    ]);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects non-allowlisted methods before spawning', async () => {
    const spawnImpl = vi.fn(() => makeChild());
    await expect(callCodexAppServer([
      { method: 'thread/start' as never },
    ], { spawnImpl: spawnImpl as never })).rejects.toThrow('allowlisted');
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('turns missing old methods into partial unavailable results', async () => {
    const child = makeChild();
    const promise = callCodexAppServer([
      { method: 'account/usage/read' },
      { method: 'model/list', params: { limit: 100 } },
    ], { spawnImpl: vi.fn(() => child) as never });

    child.stdout.write(frame({ id: 1, result: {} }));
    child.stdout.write(frame({ id: 2, error: { code: -32601, message: 'Method not found' } }));
    child.stdout.write(frame({ id: 3, result: { data: [] } }));

    await expect(promise).resolves.toEqual([
      { method: 'account/usage/read', ok: false, error: 'Codex app-server method unavailable', unavailable: true },
      { method: 'model/list', ok: true, result: { data: [] } },
    ]);
  });

  it('fails safely on oversized frames', async () => {
    const child = makeChild();
    const promise = callCodexAppServer([
      { method: 'model/list', params: { limit: 100 } },
    ], { spawnImpl: vi.fn(() => child) as never, maxFrameBytes: 10 });

    child.stdout.write(Buffer.from('Content-Length: 100\r\n\r\n{}', 'ascii'));
    await expect(promise).resolves.toEqual([
      { method: 'model/list', ok: false, error: 'Codex app-server sent an invalid response' },
    ]);
  });

  it('coalesces identical reads', async () => {
    const child = makeChild();
    const spawnImpl = vi.fn(() => child);
    const first = callCodexAppServer([{ method: 'model/list', params: { limit: 100 } }], { spawnImpl: spawnImpl as never });
    const second = callCodexAppServer([{ method: 'model/list', params: { limit: 100 } }], { spawnImpl: spawnImpl as never });

    child.stdout.write(frame({ id: 1, result: {} }));
    child.stdout.write(frame({ id: 2, result: { data: [] } }));

    await expect(Promise.all([first, second])).resolves.toEqual([
      [{ method: 'model/list', ok: true, result: { data: [] } }],
      [{ method: 'model/list', ok: true, result: { data: [] } }],
    ]);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });
});
