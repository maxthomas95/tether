import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  exec: vi.fn(),
  get: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => '.',
  },
}));

vi.mock('../db/environment-repo', () => ({
  getEnvironment: () => ({ id: 'env', type: 'coder', name: 'Coder', config: JSON.stringify(mocks.config) }),
}));
vi.mock('../logger', () => ({ createLogger: () => mocks.log }));
vi.mock('node:child_process', () => ({ execFile: mocks.exec }));
vi.mock('node:https', () => ({ get: mocks.get }));
vi.mock('node:http', () => ({ get: mocks.get }));

import { createCoderWorkspace, getCoderTemplateParams, listCoderWorkspaces, redactCoderCreateArgsForLog } from './workspace-service';

const ptyModule: typeof import('node-pty') = require('node-pty');
let data: (value: string) => void;
let exit: (event: { exitCode: number }) => void;
let spawn: ReturnType<typeof vi.spyOn>;
let kill: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.config = {};
  mocks.exec.mockImplementation((_binary, args, _options, callback) => {
    const stdout = args[0] === 'whoami' ? JSON.stringify({ url: 'https://coder.example.test/' })
      : args[0] === 'tokens' ? 'fixture-api-token\n' : '[]';
    callback(null, stdout, '');
  });
  kill = vi.fn();
  spawn = vi.spyOn(ptyModule, 'spawn').mockReturnValue({
    kill,
    onData: (callback: typeof data) => { data = callback; },
    onExit: (callback: typeof exit) => { exit = callback; },
  } as unknown as import('node-pty').IPty);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function apiReply(statusCode: number, body: string) {
  mocks.get.mockImplementation((_url, _options, callback) => {
    const request = new EventEmitter();
    Promise.resolve().then(() => {
      const response = Object.assign(new EventEmitter(), { statusCode });
      callback(response);
      response.emit('data', Buffer.from(body));
      response.emit('end');
    });
    return request;
  });
}

const createOptions = { environmentId: 'env', workspaceName: 'review-workspace', templateName: 'dev', parameters: { api_key: 'fixture-secret' } };

describe('workspace-service', () => {
  it('redacts coder create parameter values from log args', () => {
    expect(redactCoderCreateArgsForLog([
      'create',
      'ws',
      '--template',
      'tmpl',
      '--parameter',
      'api_key=secret-token',
      '--parameter',
      'size=large',
    ])).toEqual([
      'create',
      'ws',
      '--template',
      'tmpl',
      '--parameter',
      'api_key=[redacted]',
      '--parameter',
      'size=[redacted]',
    ]);
  });

  it('keeps valid workspaces and normalizes malformed fields', async () => {
    mocks.exec.mockImplementation((_binary, _args, _options, callback) => callback(null, JSON.stringify([
      { name: 'dev', owner_name: 'alice', latest_build: { status: 'running' } },
      { name: 'fallback', owner: 'bob', status: 'stopped' },
      { name: 'partial', owner: 123, latest_build: { status: {} } },
      { name: 123 },
    ]), ''));
    expect(await listCoderWorkspaces('env')).toEqual([
      { name: 'dev', owner: 'alice', status: 'running' },
      { name: 'fallback', owner: 'bob', status: 'stopped' },
      { name: 'partial', owner: '', status: 'unknown' },
    ]);
    expect(mocks.exec).toHaveBeenCalledWith('coder', ['list', '--output', 'json'], expect.objectContaining({ timeout: 10_000 }), expect.any(Function));
  });

  it('reports CLI errors and malformed JSON instead of treating them as no workspaces', async () => {
    mocks.exec.mockImplementationOnce((_binary, _args, _options, callback) => callback(new Error('exit 1'), '', 'login required'));
    await expect(listCoderWorkspaces('env')).rejects.toThrow('login required');
    mocks.exec.mockImplementationOnce((_binary, _args, _options, callback) => callback(null, '{invalid', ''));
    await expect(listCoderWorkspaces('env')).rejects.toThrow('Failed to parse coder CLI output');
  });

  it('uses a short-lived token and verified TLS when reading template parameters', async () => {
    apiReply(200, JSON.stringify([
      { name: 'region', default_value: 'west', required: true, options: [{ name: 'West', value: 'west' }] },
      { name: 'temporary', ephemeral: true },
      null,
    ]));
    expect(await getCoderTemplateParams('env', 'version-id')).toEqual([
      { name: 'region', displayName: 'region', description: '', type: 'string', defaultValue: 'west', required: true, options: [{ name: 'West', value: 'west' }] },
    ]);
    expect(mocks.exec).toHaveBeenCalledWith('coder', ['tokens', 'create', '--lifetime', '5m'], expect.any(Object), expect.any(Function));
    expect(mocks.get).toHaveBeenCalledWith('https://coder.example.test/api/v2/templateversions/version-id/rich-parameters', {
      headers: { 'Coder-Session-Token': 'fixture-api-token' }, timeout: 10_000,
    }, expect.any(Function));
  });

  it.each([
    [403, '{}', 'Coder API returned 403'],
    [200, '{invalid', 'Failed to parse template parameters'],
  ])('reports template API failure (%i)', async (status, body, message) => {
    apiReply(status, body);
    await expect(getCoderTemplateParams('env', 'version-id')).rejects.toThrow(message);
  });

  it('fails a stalled parameter request when its socket times out', async () => {
    let request: EventEmitter & { destroy: ReturnType<typeof vi.fn> };
    mocks.get.mockImplementation(() => {
      request = Object.assign(new EventEmitter(), { destroy: vi.fn((error: Error) => request.emit('error', error)) });
      return request;
    });
    const rejected = expect(getCoderTemplateParams('env', 'version-id')).rejects.toThrow('timed out');
    await vi.waitFor(() => expect(mocks.get).toHaveBeenCalled());
    request!.emit('timeout');
    await rejected;
    expect(request!.destroy).toHaveBeenCalledOnce();
  });

  it('reports progress and resolves only after successful workspace creation', async () => {
    const progress = vi.fn();
    const result = createCoderWorkspace(createOptions, progress);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    data('\x1b[32mPlanning workspace\x1b[0m\r\n');
    expect(progress).toHaveBeenCalledExactlyOnceWith('Planning workspace');
    expect(spawn).toHaveBeenCalledWith('coder', ['create', 'review-workspace', '--template', 'dev', '--yes', '--parameter', 'api_key=fixture-secret'], expect.any(Object));
    exit({ exitCode: 0 });
    expect(await result).toEqual({ name: 'review-workspace', owner: 'me', status: 'starting' });
    expect(vi.getTimerCount()).toBe(0);
    expect(JSON.stringify(mocks.log.info.mock.calls)).not.toContain('fixture-secret');
  });

  it('kills creation that stalls on an interactive parameter prompt', async () => {
    const rejected = expect(createCoderWorkspace(createOptions)).rejects.toThrow('unsupplied parameters: region');
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    data('var region\r\nEnter a value:\r\n');
    await rejected;
    expect(kill).toHaveBeenCalledOnce();
    exit({ exitCode: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('kills creation after the deadline and ignores its later success exit', async () => {
    const rejected = expect(createCoderWorkspace(createOptions)).rejects.toThrow('timed out after 5 minutes');
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(300_000);
    await rejected;
    expect(kill).toHaveBeenCalledOnce();
    exit({ exitCode: 0 });
  });

  it('includes useful failure output while redacting parameter values in the command', async () => {
    const result = createCoderWorkspace(createOptions);
    const rejected = expect(result).rejects.toThrow('coder create failed (exit 2)');
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    data('\x1b[31mError: template unavailable\x1b[0m\r\n');
    exit({ exitCode: 2 });
    await rejected;
    await expect(result).rejects.toThrow('api_key=[redacted]');
    await expect(result).rejects.not.toThrow('fixture-secret');
    expect(vi.getTimerCount()).toBe(0);
  });
});
