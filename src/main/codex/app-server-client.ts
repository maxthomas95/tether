import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import packageJson from '../../../package.json';
import {
  resolveCodexExecutable,
  resolveWindowsSystemExecutable,
  type CodexExecutableLaunch,
} from './executable-resolver';

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
  signal?: AbortSignal;
  spawnImpl?: typeof spawn;
  cleanupSpawnImpl?: typeof spawn;
  resolveCodexExecutableImpl?: typeof resolveCodexExecutable;
  resolveWindowsSystemExecutableImpl?: typeof resolveWindowsSystemExecutable;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const ALLOWED_METHODS = new Set<CodexAppServerMethod>([
  'account/read',
  'account/usage/read',
  'account/rateLimits/read',
  'config/read',
  'model/list',
]);

const inflight = new Map<string, Promise<CodexAppServerCallResult[]>>();

export function resetCodexAppServerClientForTests(): void {
  inflight.clear();
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
  if (calls.length === 0) return [];

  const seenMethods = new Set<CodexAppServerMethod>();
  for (const call of calls) {
    if (!ALLOWED_METHODS.has(call.method)) {
      throw new Error('Codex app-server method is not allowlisted');
    }
    if (seenMethods.has(call.method)) {
      throw new Error('Codex app-server calls must not repeat a method');
    }
    seenMethods.add(call.method);
  }

  const key = JSON.stringify(calls);
  if (!options.signal) {
    const existing = inflight.get(key);
    if (existing) return existing;
  }

  const request = runCodexAppServer(calls, options).finally(() => {
    inflight.delete(key);
  });
  if (!options.signal) {
    inflight.set(key, request);
  }
  return request;
}

function spawnCodexAppServer(
  spawnImpl: typeof spawn,
  resolveCodexExecutableImpl: typeof resolveCodexExecutable,
): ChildProcessWithoutNullStreams | null {
  const launch = resolveCodexExecutableImpl();
  if (!launch) return null;
  return spawnImpl(launch.file, launch.args, spawnOptions(launch));
}

function spawnOptions(launch: CodexExecutableLaunch): SpawnOptionsWithoutStdio {
  return {
    detached: launch.kind === 'direct' && process.platform !== 'win32',
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
  const cleanupSpawnImpl = options.cleanupSpawnImpl ?? spawn;
  const resolveCodexExecutableImpl = options.resolveCodexExecutableImpl ?? resolveCodexExecutable;
  const resolveWindowsSystemExecutableImpl = options.resolveWindowsSystemExecutableImpl ?? resolveWindowsSystemExecutable;

  return new Promise(resolve => {
    if (options.signal?.aborted) {
      resolve(calls.map(call => errorResult(call.method, 'Codex app-server request cancelled')));
      return;
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      const spawned = spawnCodexAppServer(spawnImpl, resolveCodexExecutableImpl);
      if (!spawned) {
        resolve(calls.map(call => unavailable(call.method)));
        return;
      }
      child = spawned;
    } catch {
      resolve(calls.map(call => unavailable(call.method)));
      return;
    }

    const pending = new Map<RequestId, CodexAppServerMethod>();
    const results = new Map<CodexAppServerMethod, CodexAppServerCallResult>();
    const parser = new JsonLineParser(maxFrameBytes);
    let settled = false;
    let initialized = false;
    let nextId = 1;
    let receivedBytes = 0;

    child.stderr.resume();

    const abort = () => {
      finish(calls.map(call => results.get(call.method) ?? errorResult(call.method, 'Codex app-server request cancelled')));
    };
    options.signal?.addEventListener('abort', abort, { once: true });

    const timer = setTimeout(() => {
      finish(calls.map(call => results.get(call.method) ?? unavailable(call.method)));
    }, timeoutMs);

    const finish = (value: CodexAppServerCallResult[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      disposeChild(child, cleanupSpawnImpl, resolveWindowsSystemExecutableImpl);
      resolve(value);
    };

    child.on('error', () => finish(calls.map(call => unavailable(call.method))));
    child.stdin.on('error', () => finish(calls.map(call => errorResult(call.method, 'Codex app-server request failed'))));
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
        const response = asResponse(message);
        if (!response) continue;
        if (response.id === 1 && !initialized) {
          if (response.error || response.result === undefined) {
            finish(calls.map(call => errorResult(call.method, 'Codex app-server initialize failed')));
            return;
          }
          initialized = true;
          writeMessage(child, { method: 'initialized' }, finish, calls);
          for (const call of calls) {
            const id = ++nextId;
            pending.set(id, call.method);
            writeMessage(child, { id, method: call.method, params: call.params ?? null }, finish, calls);
          }
          continue;
        }

        const id = typeof response.id === 'number' ? response.id : null;
        if (id === null) continue;
        const method = pending.get(id);
        if (!method) continue;
        pending.delete(id);
        if (response.error) {
          const unavailableMethod = isMethodUnavailable(response.error);
          results.set(method, {
            method,
            ok: false,
            error: unavailableMethod ? 'Codex app-server method unavailable' : 'Codex app-server request failed',
            unavailable: unavailableMethod,
          });
        } else if (!hasOwn(response, 'result')) {
          results.set(method, errorResult(method, 'Codex app-server sent an invalid response'));
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
        clientInfo: { name: 'tether', title: 'Tether', version: packageJson.version },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: ['thread/started', 'turn/started', 'agent/message/delta'],
        },
      },
    }, finish, calls);
  });
}

function writeMessage(
  child: ChildProcessWithoutNullStreams,
  message: unknown,
  finish: (value: CodexAppServerCallResult[]) => void,
  calls: CodexAppServerCall[],
): void {
  child.stdin.write(`${JSON.stringify(message)}\n`, error => {
    if (error) {
      finish(calls.map(call => errorResult(call.method, 'Codex app-server request failed')));
    }
  });
}

function asResponse(message: unknown): JsonRpcResponse | null {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    return null;
  }
  return message as JsonRpcResponse;
}

function hasOwn<T extends object>(object: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
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

function disposeChild(
  child: ChildProcessWithoutNullStreams,
  cleanupSpawnImpl: typeof spawn,
  resolveWindowsSystemExecutableImpl: typeof resolveWindowsSystemExecutable,
): void {
  if (!child.pid || child.killed || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    try {
      const taskkill = resolveWindowsSystemExecutableImpl('taskkill.exe');
      const killer = cleanupSpawnImpl(taskkill, ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        shell: false,
        stdio: 'ignore',
      });
      killer.once('error', () => killDirectChild(child));
      killer.once('exit', code => {
        if (code !== 0) killDirectChild(child);
      });
      return;
    } catch {
      // Fall back to killing the direct child below.
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
      return;
    } catch {
      // Fall back to killing the direct child below. The helper is spawned as
      // its own process group on POSIX, so group kill cannot target unrelated siblings.
    }
  }
  killDirectChild(child);
}

function killDirectChild(child: ChildProcessWithoutNullStreams): void {
  if (child.killed || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill();
  } catch {
    // Ignore cleanup failures; callers receive a generic safe error.
  }
}

class JsonLineParser {
  private readonly decoder = new StringDecoder('utf8');
  private pending = Buffer.alloc(0);

  constructor(private readonly maxFrameBytes: number) {}

  push(chunk: Buffer): unknown[] {
    const messages: unknown[] = [];
    this.pending = Buffer.concat([this.pending, chunk]);
    let newlineIndex = this.pending.indexOf(0x0a);
    while (newlineIndex !== -1) {
      if (newlineIndex > this.maxFrameBytes) {
        throw new Error('oversized frame');
      }
      const lineBytes = this.pending.subarray(0, newlineIndex);
      const line = this.decoder.write(lineBytes).replace(/\r$/, '');
      this.pending = this.pending.subarray(newlineIndex + 1);
      if (line.trim().length > 0) {
        messages.push(JSON.parse(line));
      }
      newlineIndex = this.pending.indexOf(0x0a);
    }
    if (this.pending.length > this.maxFrameBytes) {
      throw new Error('oversized frame');
    }
    return messages;
  }
}
