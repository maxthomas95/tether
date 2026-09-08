import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';

type RequestId = number;

export type CodexAppServerMethod =
  | 'account/read'
  | 'account/usage/read'
  | 'account/rateLimits/read'
  | 'config/read'
  | 'model/list';

export interface CodexAppServerCall {
  method: CodexAppServerMethod;
  params?: unknown;
}

export interface CodexAppServerCallResult {
  method: CodexAppServerMethod;
  ok: boolean;
  result?: unknown;
  error?: string;
  unavailable?: boolean;
}

export interface CodexAppServerClientOptions {
  timeoutMs?: number;
  maxFrameBytes?: number;
  maxResponseBytes?: number;
  spawnImpl?: typeof spawn;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const CACHE_TTL_MS = 2_500;
const ALLOWED_METHODS = new Set<CodexAppServerMethod>([
  'account/read',
  'account/usage/read',
  'account/rateLimits/read',
  'config/read',
  'model/list',
]);

const inflight = new Map<string, Promise<CodexAppServerCallResult[]>>();
const cache = new Map<string, { expiresAt: number; value: CodexAppServerCallResult[] }>();

export function resetCodexAppServerClientForTests(): void {
  inflight.clear();
  cache.clear();
}

interface JsonRpcResponse {
  id?: RequestId | string | null;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export async function callCodexAppServer(
  calls: CodexAppServerCall[],
  options: CodexAppServerClientOptions = {},
): Promise<CodexAppServerCallResult[]> {
  for (const call of calls) {
    if (!ALLOWED_METHODS.has(call.method)) {
      throw new Error('Codex app-server method is not allowlisted');
    }
  }

  const key = JSON.stringify(calls);
  const cached = cache.get(key);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.value.map(row => ({ ...row }));
  }

  const existing = inflight.get(key);
  if (existing) {
    return existing;
  }

  const request = runCodexAppServer(calls, options).then(value => {
    cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
    return value;
  }).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, request);
  return request;
}

function spawnCodexAppServer(spawnImpl: typeof spawn): ChildProcessWithoutNullStreams {
  if (process.platform === 'win32') {
    return spawnImpl('cmd.exe', ['/d', '/s', '/c', 'codex', 'app-server'], spawnOptions());
  }
  return spawnImpl('codex', ['app-server'], spawnOptions());
}

function spawnOptions(): SpawnOptionsWithoutStdio {
  return {
    windowsHide: true,
    shell: false,
    stdio: 'pipe',
  };
}

function runCodexAppServer(
  calls: CodexAppServerCall[],
  options: CodexAppServerClientOptions,
): Promise<CodexAppServerCallResult[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const spawnImpl = options.spawnImpl ?? spawn;

  return new Promise(resolve => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnCodexAppServer(spawnImpl);
    } catch {
      resolve(calls.map(call => unavailable(call.method)));
      return;
    }

    const pending = new Map<RequestId, CodexAppServerMethod>();
    const results = new Map<CodexAppServerMethod, CodexAppServerCallResult>();
    const parser = new ContentLengthParser(maxFrameBytes);
    let settled = false;
    let sentInitialized = false;
    let nextId = 1;
    let receivedBytes = 0;

    child.stderr.resume();

    const timer = setTimeout(() => {
      finish(calls.map(call => results.get(call.method) ?? unavailable(call.method)));
    }, timeoutMs);

    const finish = (value: CodexAppServerCallResult[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      disposeChild(child);
      resolve(value);
    };

    child.on('error', () => finish(calls.map(call => unavailable(call.method))));
    child.on('exit', () => {
      if (!settled) {
        finish(calls.map(call => results.get(call.method) ?? unavailable(call.method)));
      }
    });

    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      receivedBytes += chunk.length;
      if (receivedBytes > maxResponseBytes) {
        finish(calls.map(call => results.get(call.method) ?? errorResult(call.method, 'Codex app-server response was too large')));
        return;
      }

      let messages: unknown[];
      try {
        messages = parser.push(chunk);
      } catch {
        finish(calls.map(call => errorResult(call.method, 'Codex app-server sent an invalid response')));
        return;
      }

      for (const message of messages) {
        const response = message as JsonRpcResponse;
        if (response.id === 1 && !sentInitialized) {
          sentInitialized = true;
          writeMessage(child, { method: 'initialized' });
          for (const call of calls) {
            const id = ++nextId;
            pending.set(id, call.method);
            writeMessage(child, { id, method: call.method, params: call.params ?? null });
          }
          continue;
        }

        const id = typeof response.id === 'number' ? response.id : null;
        if (id === null) continue;
        const method = pending.get(id);
        if (!method) continue;
        pending.delete(id);
        if (response.error) {
          const message = isMethodUnavailable(response.error) ? 'Codex app-server method unavailable' : 'Codex app-server request failed';
          results.set(method, { method, ok: false, error: message, unavailable: isMethodUnavailable(response.error) });
        } else {
          results.set(method, { method, ok: true, result: response.result });
        }
        if (pending.size === 0) {
          finish(calls.map(call => results.get(call.method) ?? unavailable(call.method)));
        }
      }
    });

    writeMessage(child, {
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'tether', title: 'Tether', version: '0.6.4' },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: ['thread/started', 'turn/started', 'agent/message/delta'],
        },
      },
    });
  });
}

function writeMessage(child: ChildProcessWithoutNullStreams, message: unknown): void {
  const body = Buffer.from(JSON.stringify(message), 'utf-8');
  child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  child.stdin.write(body);
}

function isMethodUnavailable(error: { code?: number; message?: string }): boolean {
  const text = String(error.message ?? '').toLowerCase();
  return error.code === -32601 || text.includes('method') && text.includes('not found');
}

function unavailable(method: CodexAppServerMethod): CodexAppServerCallResult {
  return { method, ok: false, error: 'Codex app-server unavailable', unavailable: true };
}

function errorResult(method: CodexAppServerMethod, error: string): CodexAppServerCallResult {
  return { method, ok: false, error };
}

function disposeChild(child: ChildProcessWithoutNullStreams): void {
  if (!child.pid || child.killed) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, shell: false, stdio: 'ignore' });
      return;
    } catch {
      // Fall back to killing the direct child below.
    }
  }
  try {
    child.kill();
  } catch {
    // Ignore cleanup failures; callers receive a generic safe error.
  }
}

class ContentLengthParser {
  private buffer = Buffer.alloc(0);

  constructor(private readonly maxFrameBytes: number) {}

  push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];

    while (this.buffer.length > 0) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        if (this.buffer.length > this.maxFrameBytes) throw new Error('oversized header');
        break;
      }

      const header = this.buffer.slice(0, headerEnd).toString('ascii');
      const match = /^Content-Length:\s*(\d+)$/im.exec(header);
      if (!match) throw new Error('missing content length');
      const length = Number(match[1]);
      if (!Number.isSafeInteger(length) || length < 0 || length > this.maxFrameBytes) {
        throw new Error('invalid content length');
      }

      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (this.buffer.length < bodyEnd) break;
      const body = this.buffer.slice(bodyStart, bodyEnd).toString('utf-8');
      messages.push(JSON.parse(body));
      this.buffer = this.buffer.slice(bodyEnd);
    }

    return messages;
  }
}
