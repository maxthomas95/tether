import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { callCodexAppServer, resetCodexAppServerClientForTests } from './app-server-client';

function jsonl(message: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(message)}\n`, 'utf-8');
}

function makeChild(pid?: number) {
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
  child.pid = pid;
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

  it('initializes over JSONL, sends initialized, then reads allowlisted methods', async () => {
    const child = makeChild();
    const spawnImpl = vi.fn(() => child);
    const writes: string[] = [];
    child.stdin.on('data', chunk => writes.push(String(chunk)));

    const promise = callCodexAppServer([
      { method: 'account/read', params: { refreshToken: false } },
    ], { spawnImpl: spawnImpl as never });

    child.stdout.write(jsonl({ id: 1, result: { codexHome: 'x', platformFamily: 'windows', platformOs: 'windows', userAgent: 'codex' } }));
    await vi.waitFor(() => expect(writes.join('')).toContain('"method":"initialized"'));
    expect(writes.every(write => write.endsWith('\n'))).toBe(true);
    expect(writes.join('')).not.toContain('Content-Length');
    expect(writes.join('')).toContain('"method":"account/read"');
    expect(writes.join('')).toContain('"refreshToken":false');

    child.stdout.write(jsonl({ id: 2, result: { account: { type: 'apiKey' }, requiresOpenaiAuth: false } }));
    await expect(promise).resolves.toEqual([
      { method: 'account/read', ok: true, result: { account: { type: 'apiKey' }, requiresOpenaiAuth: false } },
    ]);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  it('handles fragmented UTF-8 JSONL frames', async () => {
    const child = makeChild();
    const promise = callCodexAppServer([
      { method: 'model/list', params: { limit: 100 } },
    ], { spawnImpl: vi.fn(() => child) as never });
    const modelFrame = jsonl({ id: 2, result: { data: [{ id: 'm', displayName: 'GPT café', description: 'café', model: 'm' }] } });
    const splitAt = modelFrame.indexOf(Buffer.from('é'));

    child.stdout.write(jsonl({ id: 1, result: {} }));
    child.stdout.write(modelFrame.subarray(0, splitAt + 1));
    child.stdout.write(modelFrame.subarray(splitAt + 1));

    await expect(promise).resolves.toEqual([
      { method: 'model/list', ok: true, result: { data: [{ id: 'm', displayName: 'GPT café', description: 'café', model: 'm' }] } },
    ]);
  });

  it('rejects non-allowlisted methods before spawning', async () => {
    const spawnImpl = vi.fn(() => makeChild());
    await expect(callCodexAppServer([
      { method: 'thread/start' as never },
    ], { spawnImpl: spawnImpl as never })).rejects.toThrow('allowlisted');
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('stops after initialize errors without sending read calls', async () => {
    const child = makeChild();
    const writes: string[] = [];
    child.stdin.on('data', chunk => writes.push(String(chunk)));
    const promise = callCodexAppServer([
      { method: 'config/read', params: { includeLayers: true, cwd: null } },
    ], { spawnImpl: vi.fn(() => child) as never });

    child.stdout.write(jsonl({ id: 1, error: { code: -32000, message: 'SECRET backend detail' } }));

    await expect(promise).resolves.toEqual([
      { method: 'config/read', ok: false, error: 'Codex app-server initialize failed' },
    ]);
    expect(writes.join('')).not.toContain('"config/read"');
    expect(writes.join('')).not.toContain('SECRET');
  });

  it('stops when initialize has no result', async () => {
    const child = makeChild();
    const promise = callCodexAppServer([
      { method: 'model/list', params: { limit: 100 } },
    ], { spawnImpl: vi.fn(() => child) as never });

    child.stdout.write(jsonl({ id: 1 }));

    await expect(promise).resolves.toEqual([
      { method: 'model/list', ok: false, error: 'Codex app-server initialize failed' },
    ]);
  });

  it('ignores null, array, scalar, and notifications safely', async () => {
    const child = makeChild();
    const promise = callCodexAppServer([
      { method: 'account/usage/read' },
    ], { spawnImpl: vi.fn(() => child) as never });

    child.stdout.write(jsonl(null));
    child.stdout.write(jsonl(['unexpected']));
    child.stdout.write(jsonl('unexpected'));
    child.stdout.write(jsonl({ method: 'account/updated', params: { token: 'SECRET' } }));
    child.stdout.write(jsonl({ id: 1, result: {} }));
    child.stdout.write(jsonl({ id: 2, result: { summary: {} } }));

    await expect(promise).resolves.toEqual([
      { method: 'account/usage/read', ok: true, result: { summary: {} } },
    ]);
  });

  it('turns missing old methods into partial unavailable results without raw errors', async () => {
    const child = makeChild();
    const promise = callCodexAppServer([
      { method: 'account/usage/read' },
      { method: 'model/list', params: { limit: 100 } },
    ], { spawnImpl: vi.fn(() => child) as never });

    child.stdout.write(jsonl({ id: 1, result: {} }));
    child.stdout.write(jsonl({ id: 2, error: { code: -32601, message: 'Method not found SECRET detail' } }));
    child.stdout.write(jsonl({ id: 3, result: { data: [] } }));

    await expect(promise).resolves.toEqual([
      { method: 'account/usage/read', ok: false, error: 'Codex app-server method unavailable', unavailable: true },
      { method: 'model/list', ok: true, result: { data: [] } },
    ]);
  });

  it('fails safely on oversized JSONL frames', async () => {
    const child = makeChild();
    const promise = callCodexAppServer([
      { method: 'model/list', params: { limit: 100 } },
    ], { spawnImpl: vi.fn(() => child) as never, maxFrameBytes: 10 });

    child.stdout.write(Buffer.from('{"id":1,"result":{}}\n', 'utf-8'));
    await expect(promise).resolves.toEqual([
      { method: 'model/list', ok: false, error: 'Codex app-server sent an invalid response' },
    ]);
  });

  it('reports stdin EPIPE as a generic request failure', async () => {
    const child = makeChild();
    const promise = callCodexAppServer([
      { method: 'model/list', params: { limit: 100 } },
    ], { spawnImpl: vi.fn(() => child) as never });

    child.stdin.emit('error', Object.assign(new Error('write EPIPE SECRET'), { code: 'EPIPE' }));

    await expect(promise).resolves.toEqual([
      { method: 'model/list', ok: false, error: 'Codex app-server request failed' },
    ]);
  });

  it('cancels and disposes the spawned helper', async () => {
    const child = makeChild(456);
    const cleanup = makeChild();
    const cleanupSpawnImpl = vi.fn(() => cleanup);
    const controller = new AbortController();
    const promise = callCodexAppServer([
      { method: 'model/list', params: { limit: 100 } },
    ], {
      signal: controller.signal,
      spawnImpl: vi.fn(() => child) as never,
      cleanupSpawnImpl: cleanupSpawnImpl as never,
    });

    controller.abort();

    await expect(promise).resolves.toEqual([
      { method: 'model/list', ok: false, error: 'Codex app-server request cancelled' },
    ]);
    if (process.platform === 'win32') {
      expect(cleanupSpawnImpl).toHaveBeenCalledWith('taskkill.exe', ['/pid', '456', '/t', '/f'], expect.any(Object));
    } else {
      expect(cleanupSpawnImpl).toHaveBeenCalledWith('pkill', ['-TERM', '-P', '456'], expect.any(Object));
      expect(child.kill).toHaveBeenCalled();
    }
    cleanup.emit('error', new Error('taskkill failed'));
  });

  it('coalesces identical in-flight reads without caching completed raw payloads', async () => {
    const firstChild = makeChild();
    const secondChild = makeChild();
    const spawnImpl = vi.fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild);
    const first = callCodexAppServer([{ method: 'model/list', params: { limit: 100 } }], { spawnImpl: spawnImpl as never });
    const coalesced = callCodexAppServer([{ method: 'model/list', params: { limit: 100 } }], { spawnImpl: spawnImpl as never });

    firstChild.stdout.write(jsonl({ id: 1, result: {} }));
    firstChild.stdout.write(jsonl({ id: 2, result: { data: [] } }));

    await expect(Promise.all([first, coalesced])).resolves.toEqual([
      [{ method: 'model/list', ok: true, result: { data: [] } }],
      [{ method: 'model/list', ok: true, result: { data: [] } }],
    ]);

    const afterCompletion = callCodexAppServer([{ method: 'model/list', params: { limit: 100 } }], { spawnImpl: spawnImpl as never });
    secondChild.stdout.write(jsonl({ id: 1, result: {} }));
    secondChild.stdout.write(jsonl({ id: 2, result: { data: [{ id: 'new' }] } }));

    await expect(afterCompletion).resolves.toEqual([
      { method: 'model/list', ok: true, result: { data: [{ id: 'new' }] } },
    ]);
    expect(spawnImpl).toHaveBeenCalledTimes(2);
  });
});
