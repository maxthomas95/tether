import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, it, expect, vi } from 'vitest';
import { generatePipComment, selectPipModel } from './pip-comment-client';

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    pid: undefined, killed: false, exitCode: null, signalCode: null, kill: vi.fn(),
  });
  const writes: Record<string, unknown>[] = [];
  child.stdin.on('data', chunk => writes.push(JSON.parse(String(chunk))));
  const spawn = vi.fn(() => child);
  const resolver = vi.fn(() => ({ kind: 'direct' as const, file: '/usr/bin/codex', args: ['app-server'] }));
  const frame = (value: unknown) => child.stdout.write(Buffer.from(JSON.stringify(value) + '\n'));
  const start = (signal?: AbortSignal, timeoutMs?: number) => generatePipComment({
    cwd: '/neutral', event: 'submitted', personality: 'dry', prompt: 'Fix my loop',
    spawnImpl: spawn as never, resolveCodexExecutableImpl: resolver, signal, timeoutMs,
  });
  const metadata = (type = 'chatgpt', model = 'gpt-6-luna') => {
    frame({ id: 1, result: {} });
    frame({ id: 2, result: { account: { type } } });
    frame({ id: 3, result: { data: [{ model, supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'low' }] }] } });
    frame({ id: 4, result: { config: { mcp_servers: { private: { command: 'DO_NOT_LAUNCH' } } } } });
  };
  const thread = (model = 'gpt-6-luna') => frame({ id: 5, result: { model, modelProvider: 'openai', thread: { id: 'pip', ephemeral: true } } });
  return { child, writes, spawn, resolver, frame, start, metadata, thread };
}

describe('Pip bounded Codex turn', () => {
  it('discovers the economical tier, uses lowest supported effort, and never chooses full models', () => {
    expect(selectPipModel({ data: [{ model: 'gpt-6.1-sol' }] })).toBeNull();
    expect(selectPipModel({ data: [{ model: 'gpt-5.6-luna' }] })?.model).toBe('gpt-5.6-luna');
    expect(selectPipModel({ data: [{ model: 'gpt-6-luna', hidden: true }] })).toBeNull();
  });
  it('runs one temporary ChatGPT turn with MCP disabled and collects only its final message', async () => {
    const f = fixture();
    const pending = f.start();
    f.metadata();
    const start = f.writes.find(row => row.method === 'thread/start')!;
    expect(start.params).toMatchObject({ cwd: '/neutral', ephemeral: true, sandbox: 'read-only', modelProvider: 'openai',
      config: { 'features.shell_tool': false, 'features.apps': false, 'mcp_servers.private.enabled': false } });
    expect(f.resolver.mock.calls[0][0]).toMatchObject({ args: expect.arrayContaining(['--disable', 'hooks']) });
    f.thread();
    expect(f.writes.find(row => row.method === 'turn/start')?.params).toMatchObject({ effort: 'low', serviceTier: 'default' });
    f.frame({ id: 6, result: { turn: { id: 'quip' } } });
    f.frame({ method: 'item/completed', params: { threadId: 'other', item: { type: 'agentMessage', text: 'Wrong thread' } } });
    f.frame({ method: 'item/completed', params: { threadId: 'pip', turnId: 'quip', item: { type: 'agentMessage', text: ' Bold\nkeyboard energy. ' } } });
    f.frame({ method: 'turn/completed', params: { threadId: 'pip', turn: { id: 'quip', status: 'completed' } } });
    expect(await pending).toMatchObject({ status: 'ready', model: 'gpt-6-luna', line: 'Bold keyboard energy.' });
  });
  it.each([['apiKey', 'gpt-6-luna'], ['chatgpt', 'gpt-6.1-sol']])('refuses %s authentication with %s before starting a turn', async (auth, model) => {
    const f = fixture();
    const pending = f.start();
    f.metadata(auth, model);
    expect((await pending).line).toBeNull();
    expect(f.writes.some(row => row.method === 'thread/start')).toBe(false);
  });
  it('refuses model substitution and any tool request', async () => {
    const f = fixture();
    const pending = f.start();
    f.metadata();
    f.thread('gpt-6.1-sol');
    expect((await pending).status).toBe('unavailable');
    expect(f.writes.some(row => row.method === 'turn/start')).toBe(false);
    const g = fixture();
    const second = g.start();
    g.metadata(); g.thread();
    g.frame({ id: 99, method: 'item/commandExecution/requestApproval', params: { threadId: 'pip' } });
    expect((await second).line).toBeNull();
    expect(g.writes.some(row => row.id === 99)).toBe(false);
  });
  it('cancels and times out without surfacing provider data', async () => {
    const f = fixture();
    const controller = new AbortController();
    const pending = f.start(controller.signal);
    controller.abort();
    expect((await pending).line).toBeNull();
    const g = fixture();
    expect((await g.start(undefined, 5)).reason).toBe('AI comments unavailable. Using local quips.');
  });
});
