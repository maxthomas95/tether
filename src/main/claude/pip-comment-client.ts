import { spawn } from 'node:child_process';
import { resolveCliExecutable, resolveWindowsSystemExecutable, type CliExecutableLaunch } from '../cli/executable-resolver';
import { runCliMetadata, type CliMetadataResult } from '../cli/metadata-command';
import { disposeChild, spawnOptions } from '../codex/app-server-client';
import { PIP_BASE_INSTRUCTIONS, pipPersonalityInstructions, pipReplyLine, pipRequestText } from '../pip/instructions';
import type { PipAiEvent, PipBackendStatus, PipCommentResult, PipSettings } from '../../shared/pip';

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}; }
const FAILURE: PipCommentResult = { status: 'unavailable', line: null, model: null, reason: 'AI comments unavailable. Using local quips.' };

/**
 * Variables that would let a key, a proxy or a cloud provider stand in for the subscription sign-in.
 * Pip quips use the Claude subscription only, matching Codex, so none of these reach the child.
 */
export const PIP_CLAUDE_STRIPPED_ENV = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH', 'CLAUDE_CODE_SKIP_VERTEX_AUTH', 'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL', 'ANTHROPIC_VERTEX_PROJECT_ID', 'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_RESOURCE', 'AWS_BEARER_TOKEN_BEDROCK',
] as const;

/** The parent environment without the stripped variables (case-insensitively on Windows), with connectors off. */
export function pipClaudeEnvironment(source: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const stripped = new Set<string>(PIP_CLAUDE_STRIPPED_ENV.map(name => platform === 'win32' ? name.toUpperCase() : name));
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (!stripped.has(platform === 'win32' ? key.toUpperCase() : key)) env[key] = value;
  }
  // claude.ai connectors are fetched even with --strict-mcp-config. No tools can run, but there is no reason to load them.
  env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
  return env;
}

/** Overrides for `runCliMetadata`, which merges onto the parent environment: an undefined value removes the variable. */
function metadataOverrides(): NodeJS.ProcessEnv {
  return Object.fromEntries([...PIP_CLAUDE_STRIPPED_ENV.map(name => [name, undefined]), ['ENABLE_CLAUDEAI_MCP_SERVERS', 'false']]);
}

/**
 * One-shot flags, verified on Claude Code 2.1.322: no tools, no saved session, no user/project/local settings
 * (so no hooks, including Tether's own), no MCP servers and no skills. The request text goes on stdin, so the
 * prompt excerpt never crosses a command line or a cmd.exe shim.
 */
export function pipClaudeArgs(personality: PipSettings['personality']): string[] {
  return [
    '-p', '--model', 'haiku', '--effort', 'low', '--tools', '', '--no-session-persistence',
    '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands',
    '--system-prompt', `${PIP_BASE_INSTRUCTIONS} ${pipPersonalityInstructions(personality)}`,
    '--output-format', 'json',
  ];
}

const SUBSCRIPTION_NAMES: Readonly<Record<string, string>> = { pro: 'Claude Pro', max: 'Claude Max', team: 'Claude Team', enterprise: 'Claude Enterprise' };

/** Read `claude auth status --json`. Only the sign-in method and plan are kept; the email and org never leave this function. */
export function pipClaudeAccount(result: CliMetadataResult): { ready: true; plan: string } | { ready: false; reason: string } {
  if (!result.ok) {
    return { ready: false, reason: result.reason === 'unavailable' ? 'Claude Code is not installed or not on PATH.' : 'Could not read Claude sign-in. Using local quips.' };
  }
  let status: JsonObject;
  try { status = object(JSON.parse(result.stdout)); } catch { return { ready: false, reason: 'Could not read Claude sign-in. Using local quips.' }; }
  if (status.loggedIn !== true) return { ready: false, reason: 'Sign in to Claude Code with your Claude subscription to enable AI quips.' };
  if (status.authMethod !== 'claude.ai' || (status.apiProvider !== undefined && status.apiProvider !== 'firstParty')) {
    return { ready: false, reason: 'Claude Code is signed in with an API key or cloud provider. Pip uses only a Claude subscription sign-in.' };
  }
  const type = typeof status.subscriptionType === 'string' ? status.subscriptionType : '';
  return { ready: true, plan: SUBSCRIPTION_NAMES[type] ?? 'Claude subscription' };
}

/** Accept a one-shot result only if it was one Haiku turn that asked for nothing. */
export function pipClaudeResult(stdout: string): PipCommentResult {
  let result: JsonObject;
  try { result = object(JSON.parse(stdout)); } catch { return FAILURE; }
  const models = Object.keys(object(result.modelUsage));
  if (result.type !== 'result' || result.subtype !== 'success' || result.is_error !== false || result.num_turns !== 1
    || !Array.isArray(result.permission_denials) || result.permission_denials.length > 0
    || models.length === 0 || !models.every(model => /^claude-haiku-[\w.-]+$/.test(model))) return FAILURE;
  const line = typeof result.result === 'string' ? pipReplyLine(result.result) : null;
  return line ? { status: 'ready', line, model: models[0], reason: null } : FAILURE;
}

export interface PipClaudeOptions {
  cwd: string;
  event: PipAiEvent;
  personality: PipSettings['personality'];
  prompt: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxResponseBytes?: number;
  spawnImpl?: typeof spawn;
  cleanupSpawnImpl?: typeof spawn;
  resolveImpl?: (args: readonly string[], env: NodeJS.ProcessEnv) => CliExecutableLaunch | null;
  accountImpl?: (cwd: string) => Promise<CliMetadataResult>;
  resolveWindowsSystemExecutableImpl?: typeof resolveWindowsSystemExecutable;
}

function resolveClaude(args: readonly string[], env: NodeJS.ProcessEnv): CliExecutableLaunch | null {
  return resolveCliExecutable('claude', { args, pathEnv: env.PATH ?? env.Path ?? '', pathExt: env.PATHEXT, comSpec: env.ComSpec, systemRoot: env.SystemRoot });
}

export function readPipClaudeAccount(cwd: string): Promise<CliMetadataResult> {
  return runCliMetadata('claude', ['auth', 'status', '--json'], { cwd, env: metadataOverrides(), timeoutMs: 5000, maxBytes: 64 * 1024 });
}

export async function pipClaudeStatus(cwd: string, accountImpl = readPipClaudeAccount): Promise<PipBackendStatus> {
  const account = pipClaudeAccount(await accountImpl(cwd));
  return { backend: 'claude', ready: account.ready, detail: account.ready ? `Signed in with ${account.plan}. Quips use Claude Haiku.` : account.reason };
}

/** One Haiku turn in a neutral directory, after confirming subscription sign-in. */
export async function generatePipClaudeComment(options: PipClaudeOptions): Promise<PipCommentResult> {
  if (options.signal?.aborted) return FAILURE;
  const account = pipClaudeAccount(await (options.accountImpl ?? readPipClaudeAccount)(options.cwd).catch(() => ({ ok: false, reason: 'failed' } as const)));
  if (!account.ready) return { ...FAILURE, reason: account.reason };
  if (options.signal?.aborted) return FAILURE;
  const env = pipClaudeEnvironment();
  const spawnImpl = options.spawnImpl ?? spawn;
  const cleanup = options.cleanupSpawnImpl ?? spawn;
  const systemResolver = options.resolveWindowsSystemExecutableImpl ?? resolveWindowsSystemExecutable;
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>;
    try {
      const launch = (options.resolveImpl ?? resolveClaude)(pipClaudeArgs(options.personality), env);
      if (!launch) { resolve(FAILURE); return; }
      child = spawnImpl(launch.file, launch.args, { ...spawnOptions(launch), cwd: options.cwd, env });
    } catch { resolve(FAILURE); return; }
    if (!child.stdin || !child.stdout || !child.stderr) { child.kill(); resolve(FAILURE); return; }
    child.stderr.resume();
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    const finish = (result: PipCommentResult = FAILURE) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      disposeChild(child as Parameters<typeof disposeChild>[0], cleanup, systemResolver);
      resolve(result);
    };
    const abort = () => finish();
    const timer = setTimeout(() => finish(), options.timeoutMs ?? 20_000);
    options.signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => finish());
    child.stdin.on('error', () => finish());
    child.stdout.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > (options.maxResponseBytes ?? 1024 * 1024)) { finish(); return; }
      chunks.push(chunk);
    });
    child.on('close', code => finish(code === 0 ? pipClaudeResult(Buffer.concat(chunks).toString('utf8')) : FAILURE));
    child.stdin.end(pipRequestText(options.event, options.prompt));
  });
}
