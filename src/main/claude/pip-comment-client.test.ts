import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  PIP_CLAUDE_STRIPPED_ENV, generatePipClaudeComment, pipClaudeAccount, pipClaudeArgs, pipClaudeEnvironment, pipClaudeResult, pipClaudeStatus,
} from './pip-comment-client';
import { PIP_AI_SITUATIONS } from '../../shared/pip';

const SIGNED_IN = { ok: true as const, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max', email: 'person@example.com', orgId: 'org-1' }) };
function success(patch: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, num_turns: 1, permission_denials: [],
    modelUsage: { 'claude-haiku-5-5': { outputTokens: 20 } }, result: ' Ready when\nyou are. ', ...patch,
  });
}

function fixture(account = SIGNED_IN) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    pid: undefined, killed: false, exitCode: null, signalCode: null, kill: vi.fn(),
  });
  let input = '';
  child.stdin.on('data', chunk => { input += String(chunk); });
  const spawn = vi.fn(() => child);
  const resolveImpl = vi.fn(() => ({ kind: 'direct' as const, file: '/usr/bin/claude', args: ['-p'] }));
  const accountImpl = vi.fn(async () => account);
  const start = (signal?: AbortSignal, timeoutMs?: number) => generatePipClaudeComment({
    cwd: '/neutral', event: 'ready', personality: 'dry', prompt: 'Fix my loop',
    spawnImpl: spawn as never, resolveImpl, accountImpl, signal, timeoutMs,
  });
  const reply = (stdout: string, code = 0) => { child.stdout.write(stdout); child.stdout.end(); child.emit('close', code); };
  return { child, spawn, resolveImpl, accountImpl, start, reply, input: () => input };
}

describe('Pip Claude quip backend', () => {
  it('uses one-shot flags that load no tools, settings, hooks, MCP servers, skills or saved session', () => {
    const args = pipClaudeArgs('dry');
    expect(args).toEqual(expect.arrayContaining(['-p', '--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands']));
    for (const [flag, value] of [['--model', 'haiku'], ['--effort', 'low'], ['--tools', ''], ['--setting-sources', ''], ['--output-format', 'json']]) {
      expect(args[args.indexOf(flag) + 1]).toBe(value);
    }
    expect(args[args.indexOf('--system-prompt') + 1]).toContain('dry');
    expect(args.join(' ')).not.toContain('Fix my loop');
  });

  it('strips API keys, proxies and cloud provider switches case-insensitively on Windows', () => {
    const env = pipClaudeEnvironment({ PATH: '/bin', anthropic_api_key: 'sk-secret', ANTHROPIC_BASE_URL: 'https://proxy', Claude_Code_Use_Bedrock: '1', HOME: '/home/me' }, 'win32');
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/me', ENABLE_CLAUDEAI_MCP_SERVERS: 'false' });
    expect(pipClaudeEnvironment({ anthropic_api_key: 'kept on POSIX, where it is a different name' }, 'linux')).toHaveProperty('anthropic_api_key');
    expect(PIP_CLAUDE_STRIPPED_ENV).toEqual(expect.arrayContaining(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_VERTEX']));
  });

  it('accepts only a Claude subscription sign-in and keeps no account identifiers', async () => {
    expect(pipClaudeAccount(SIGNED_IN)).toEqual({ ready: true, plan: 'Claude Max' });
    expect(pipClaudeAccount({ ok: true, stdout: JSON.stringify({ loggedIn: true, authMethod: 'api_key' }) })).toMatchObject({ ready: false, reason: expect.stringContaining('API key') });
    expect(pipClaudeAccount({ ok: true, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'bedrock' }) })).toMatchObject({ ready: false });
    expect(pipClaudeAccount({ ok: true, stdout: JSON.stringify({ loggedIn: false }) })).toMatchObject({ ready: false, reason: expect.stringContaining('Sign in') });
    expect(pipClaudeAccount({ ok: false, reason: 'unavailable' })).toMatchObject({ ready: false, reason: expect.stringContaining('not installed') });
    expect(pipClaudeAccount({ ok: true, stdout: 'not json' })).toMatchObject({ ready: false });
    const status = await pipClaudeStatus('/neutral', async () => SIGNED_IN);
    expect(status).toEqual({ backend: 'claude', ready: true, detail: 'Signed in with Claude Max. Quips use Claude Haiku.' });
    expect(JSON.stringify(status)).not.toMatch(/example\.com|org-1/);
  });

  it('accepts only one Haiku turn that asked for nothing', () => {
    expect(pipClaudeResult(success())).toEqual({ status: 'ready', line: 'Ready when you are.', model: 'claude-haiku-5-5', reason: null });
    for (const patch of [
      { modelUsage: { 'claude-haiku-5-5': {}, 'claude-sonnet-5-5': {} } }, { modelUsage: {} }, { is_error: true }, { num_turns: 2 },
      { permission_denials: [{ tool_name: 'Bash' }] }, { subtype: 'error_max_turns' }, { result: 'x'.repeat(181) }, { result: '   ' },
    ]) expect(pipClaudeResult(success(patch)).status).toBe('unavailable');
    expect(pipClaudeResult('{').status).toBe('unavailable');
  });

  it('sends the request on stdin in a neutral directory without the stripped variables', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-should-not-pass');
    const f = fixture();
    const pending = f.start();
    await vi.waitFor(() => expect(f.spawn).toHaveBeenCalled());
    const options = (f.spawn.mock.calls[0] as unknown[])[2] as { cwd: string; env: NodeJS.ProcessEnv; shell: boolean };
    expect(options).toMatchObject({ cwd: '/neutral', shell: false });
    expect(Object.keys(options.env).map(key => key.toUpperCase())).not.toContain('ANTHROPIC_API_KEY');
    f.reply(success());
    expect(await pending).toMatchObject({ status: 'ready', line: 'Ready when you are.' });
    expect(JSON.parse(f.input())).toEqual({ event: 'ready', situation: PIP_AI_SITUATIONS.ready, submittedPromptExcerpt: 'Fix my loop' });
    vi.unstubAllEnvs();
  });

  it('never starts a quip without a subscription sign-in', async () => {
    const f = fixture({ ok: true, stdout: JSON.stringify({ loggedIn: true, authMethod: 'api_key' }) });
    expect((await f.start()).reason).toContain('API key');
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it('fails safely on a non-zero exit, a timeout, an abort, or an oversized reply', async () => {
    const exit = fixture();
    const failed = exit.start();
    await vi.waitFor(() => expect(exit.spawn).toHaveBeenCalled());
    exit.reply(success(), 1);
    expect((await failed).status).toBe('unavailable');

    const slow = fixture();
    const timedOut = slow.start(undefined, 5);
    expect((await timedOut).status).toBe('unavailable');

    const controller = new AbortController();
    const aborted = fixture();
    const cancelled = aborted.start(controller.signal);
    await vi.waitFor(() => expect(aborted.spawn).toHaveBeenCalled());
    controller.abort();
    expect((await cancelled).status).toBe('unavailable');

    const big = fixture();
    const flooded = big.start();
    await vi.waitFor(() => expect(big.spawn).toHaveBeenCalled());
    big.child.stdout.write(Buffer.alloc(1024 * 1024 + 1));
    expect((await flooded).status).toBe('unavailable');

    const early = fixture();
    const before = new AbortController();
    before.abort();
    expect((await early.start(before.signal)).status).toBe('unavailable');
    expect(early.accountImpl).not.toHaveBeenCalled();
  });
});
