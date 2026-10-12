import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { quotePosixShellArg as q } from '../../shared/shell-quote';
import { getEnvironment } from '../db/environment-repo';
import { resolveSshConfig } from '../ssh/resolve-ssh-config';
import { connectSshControl } from '../cli-config/remote/ssh-control-connection';
import { REMOTE_USAGE_PROBE } from './remote-probe';
import { RemoteAuthError, isRemoteAuthFailed, markRemoteAuthFailed } from './remote-auth-state';
import {
  validateSubagentReply,
  type RemoteSubagentReply,
  type RemoteSubagentRequest,
  type RemoteUsageReply,
  type RemoteUsageRequest,
} from './remote-protocol';

const MAX_BYTES = 4 * 1024 * 1024;
/** One reply line from the resident reader; subagent replies carry raw transcript bytes. */
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
/** How long a freshly started reader (login shell, sudo, node) has to say it is ready. */
export const READY_TIMEOUT_MS = 30_000;

/**
 * Why a request failed, so callers can tell a reader that is gone from one that
 * merely answered badly or slowly: only 'dead' (and repeated 'timeout' with no
 * reply in between) is a reason to replace the reader.
 */
export class RemoteProbeRequestError extends Error {
  constructor(message: string, readonly kind: 'dead' | 'timeout' | 'reply') {
    super(message);
    this.name = 'RemoteProbeRequestError';
  }
}

export interface RemoteUsageConnection {
  poll(request: RemoteUsageRequest): Promise<RemoteUsageReply>;
  poll(request: RemoteSubagentRequest): Promise<RemoteSubagentReply>;
  /** Set once the resident reader has exited; a dead connection never recovers. */
  isDead?(): boolean;
  close(): void;
}

/**
 * `request` omitted starts the probe resident: it reads newline-delimited
 * base64 requests from stdin instead of answering argv once. A `useSudo` host
 * then authenticates once for the connection rather than once per poll, which
 * is the difference between a handful of `sudo` calls an hour and thousands.
 */
/**
 * Whole-line comments and indentation carry nothing at run time, and the
 * program travels as one command-line argument (Windows allows ~32k), so they
 * are dropped before it is encoded.
 */
function minify(source: string): string {
  return source.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('//')).join('\n');
}

export function buildProbeCommand(request?: RemoteUsageRequest, sudo = false, password = false, ready?: string): string {
  if (ready !== undefined && !/^[0-9a-f]{16,64}$/.test(ready)) throw new Error('Invalid ready token');
  const encoded = request && Buffer.from(JSON.stringify(request)).toString('base64');
  // Encode the bundled program as well as the request. This keeps multiline
  // JavaScript out of nested shell/Windows argument quoting. Only our static
  // program is evaluated; request data is decoded with JSON.parse by the probe.
  const program = Buffer.from(minify(REMOTE_USAGE_PROBE)).toString('base64');
  const bootstrap = `eval(Buffer.from('${program}', 'base64').toString('utf8'))`;
  // A resident reader says it is up by echoing this token, which is how the
  // caller knows sudo accepted the password before it sends anything else.
  const readyEnv = ready ? `TETHER_PROBE_READY=${ready} ` : '';
  const command = `${readyEnv}exec "$(command -v node || command -v nodejs)" -e ${q(bootstrap)}${encoded ? ` ${q(encoded)}` : ''}`;
  // Login-shell context matches the CLI's home/PATH. The only password input,
  // when needed, travels over encrypted stdin, never argv/history/logs.
  const shell = `sh -lc ${q(command)}`;
  return sudo ? `sudo ${password ? "-S -p ''" : '-n'} -i -- ${shell}` : shell;
}

export const PROBE_MARKER = '__TETHER_USAGE__';

export function parseProbeLine(line: string): RemoteUsageReply {
  const reply = JSON.parse(line.slice(PROBE_MARKER.length)) as RemoteUsageReply;
  if (reply.status === 'pending') return { status: 'pending', id: reply.id };
  const s = reply.source;
  if (reply.status !== 'ready' || !s || [s.path, s.scope, s.nativeSessionId, s.identity].some(v => typeof v !== 'string' || v.length > 8192)) {
    throw new Error('Invalid remote usage reply');
  }
  if (reply.offset !== undefined && (!Number.isSafeInteger(reply.offset) || reply.offset < 0 || typeof reply.text !== 'string' || typeof reply.reset !== 'boolean')) {
    throw new Error('Invalid remote usage cursor');
  }
  return reply;
}

export function parseProbeReply(stdout: string): RemoteUsageReply {
  const line = stdout.split('\n').findLast(l => l.startsWith(PROBE_MARKER));
  if (!line) throw new Error('Remote usage reader unavailable');
  return parseProbeLine(line);
}

/** A separate, non-PTY command process; Coder owns its authenticated tunnel. */
export function coderUsageConnection(binary: string, workspace: string): RemoteUsageConnection {
  const children = new Set<ReturnType<typeof spawn>>();
  let closed = false;
  const poll = (request: RemoteUsageRequest) => new Promise<RemoteUsageReply>((resolve, reject) => {
      if (closed) { reject(new Error('Usage connection closed')); return; }
      const child = spawn(binary, ['ssh', '--disable-autostart', workspace, '--', buildProbeCommand(request)], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      children.add(child);
      const chunks: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        children.delete(child);
        if (error) { child.kill(); reject(error); return; }
        try { resolve(parseProbeReply(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('Remote usage reader unavailable')); }
      };
      const timer = setTimeout(() => finish(new Error('Remote usage command timed out')), TIMEOUT_MS);
      child.stdout.on('data', (data: Buffer) => {
        bytes += data.length;
        if (bytes > MAX_BYTES) finish(new Error('Remote usage output exceeded limit'));
        else chunks.push(data);
      });
      // Bound stderr too, but never retain or log remote shell output.
      child.stderr.on('data', (data: Buffer) => {
        bytes += data.length;
        if (bytes > MAX_BYTES) finish(new Error('Remote usage output exceeded limit'));
      });
      child.on('error', () => finish(new Error('Coder usage command failed')));
      child.on('close', code => finish(code === 0 ? undefined : new Error('Coder usage command failed')));
      child.stdin.on('error', () => { /* exit/error handles a closed pipe */ });
      child.stdin.end();
    });
  return {
    poll: poll as RemoteUsageConnection['poll'],
    close: () => {
      closed = true;
      for (const child of children) child.kill();
      children.clear();
    },
  };
}

type ProbeReply = RemoteUsageReply | RemoteSubagentReply;

/** A reply is a subagent reply when it names an `op`; usage replies never do. */
function parseResidentLine(line: string): ProbeReply {
  const parsed = JSON.parse(line.slice(PROBE_MARKER.length)) as { op?: unknown };
  return parsed.op === undefined ? parseProbeLine(line) : validateSubagentReply(parsed);
}

/** What a resident reader looks like to the request multiplexer, whatever carries it. */
interface ResidentProcess {
  write(data: string): void;
  onLine(cb: (line: string) => void): void;
  onExit(cb: () => void): void;
  /** sudo or the login refused the credentials (matched on stderr, which is never kept). */
  onAuthFailure?(cb: () => void): void;
  kill(): void;
}

/**
 * Wait for the reader's ready line before anything is written but the password.
 * `sudo -S` answers a wrong password by asking again and reading the next line
 * of stdin as the retry, so anything sent early is a further failed logon and
 * leaks the request into PAM. A refusal, or silence for `READY_TIMEOUT_MS`
 * after a password was sent, kills the process: a wrong password costs exactly
 * one attempt. Silence is also treated as a refusal there because sudo's
 * message depends on the host's language.
 */
function awaitReady(probe: ResidentProcess, token: string, passwordSent: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { try { probe.kill(); } catch { /* already gone */ } reject(error); } else resolve();
    };
    const timer = setTimeout(() => done(passwordSent ? new RemoteAuthError() : new Error('Remote usage reader did not start')), READY_TIMEOUT_MS);
    probe.onLine(line => {
      if (!line.startsWith(PROBE_MARKER)) return;
      try { if ((JSON.parse(line.slice(PROBE_MARKER.length)) as { ready?: unknown }).ready === token) done(); } catch { /* not ours */ }
    });
    probe.onAuthFailure?.(() => done(new RemoteAuthError()));
    probe.onExit(() => done(new Error('Remote usage reader did not start')));
  });
}

/**
 * Multiplexes requests over one resident reader: one newline-delimited base64
 * request per line out, one marker-prefixed JSON line back, matched by id.
 * Nothing here starts a process, so a poll costs a line of stdin and never a
 * login (or a `sudo`).
 */
function residentConnection(probe: ResidentProcess, onClose: () => void): RemoteUsageConnection {
  type Waiter = { resolve: (reply: ProbeReply) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
  const pending = new Map<number, Waiter>();
  let nextId = 0;
  let dead = false;
  const settle = (id: number, apply: (entry: Waiter) => void) => {
    const entry = pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(id);
    apply(entry);
  };
  const fail = () => {
    dead = true;
    for (const id of [...pending.keys()]) settle(id, e => e.reject(new RemoteProbeRequestError('Remote usage reader unavailable', 'dead')));
  };

  probe.onLine(line => {
    if (!line.startsWith(PROBE_MARKER)) return;
    let reply: ProbeReply | undefined;
    let error: Error | undefined;
    try { reply = parseResidentLine(line); } catch (err) { error = new RemoteProbeRequestError(err instanceof Error ? err.message : 'Invalid remote usage reply', 'reply'); }
    // An unroutable reply is left to the caller's timeout rather than guessed at.
    const id = reply?.id ?? tryReadId(line);
    if (id === undefined) return;
    settle(id, e => (reply ? e.resolve(reply) : e.reject(error!)));
  });
  probe.onExit(fail);

  const poll = (request: RemoteUsageRequest | RemoteSubagentRequest) => new Promise<ProbeReply>((resolve, reject) => {
    if (dead) { reject(new RemoteProbeRequestError('Remote usage reader unavailable', 'dead')); return; }
    const id = nextId++;
    const timer = setTimeout(() => settle(id, e => e.reject(new RemoteProbeRequestError('Remote usage command timed out', 'timeout'))), TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    try {
      probe.write(`${Buffer.from(JSON.stringify({ ...request, id })).toString('base64')}\n`);
    } catch {
      settle(id, e => e.reject(new RemoteProbeRequestError('Remote usage reader unavailable', 'dead')));
    }
  });

  return {
    poll: poll as RemoteUsageConnection['poll'],
    isDead: () => dead,
    close: () => {
      fail();
      probe.kill();
      onClose();
    },
  };
}

/**
 * One long-lived `coder ssh` carrying the resident reader. Coder owns the
 * authenticated tunnel; this is still a separate, non-PTY command, started
 * once and answering every request over its stdin/stdout.
 */
function coderResidentProcess(binary: string, workspace: string, token: string): ResidentProcess {
  const child = spawn(binary, ['ssh', '--disable-autostart', workspace, '--', buildProbeCommand(undefined, false, false, token)], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lineCbs: Array<(line: string) => void> = [];
  const exitCbs: Array<() => void> = [];
  const decoder = new StringDecoder('utf8');
  let buffered = '';
  let done = false;
  const exit = () => {
    if (done) return;
    done = true;
    for (const cb of exitCbs) { try { cb(); } catch { /* observers never throw upward */ } }
  };
  child.stdout.on('data', (data: Buffer) => {
    buffered += decoder.write(data);
    let cut: number;
    while ((cut = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, cut);
      buffered = buffered.slice(cut + 1);
      for (const cb of lineCbs) { try { cb(line); } catch { /* one bad reply never kills the stream */ } }
    }
    if (buffered.length > MAX_LINE_BYTES) { buffered = ''; child.kill(); exit(); }
  });
  // Never retain or log remote stderr; drain it so the process cannot stall.
  child.stderr.on('data', () => { /* discarded by design */ });
  child.on('error', exit);
  child.on('close', exit);
  child.stdin.on('error', () => { /* exit handles a closed pipe */ });
  return {
    write: data => { try { child.stdin.write(data); } catch { exit(); } },
    onLine: cb => { lineCbs.push(cb); },
    onExit: cb => { if (done) cb(); else exitCbs.push(cb); },
    kill: () => { try { child.kill(); } finally { exit(); } },
  };
}

export interface ConnectOptions {
  /**
   * Coder only. Keep one reader process for the whole connection instead of one
   * `coder ssh` per poll. SSH is always resident. Usage keeps the per-poll form
   * it has always had; subagent polling is frequent enough to need this one.
   */
  resident?: boolean;
}

/** ssh2's wording when every configured method was refused, i.e. a failed logon on the host. */
const SSH_AUTH_REFUSED = /authentication methods failed|authentication failed/i;

export async function connectRemoteUsage(environmentId: string, workspace: string, signal?: AbortSignal, options: ConnectOptions = {}): Promise<RemoteUsageConnection> {
  const env = getEnvironment(environmentId);
  if (!env || (env.type !== 'ssh' && env.type !== 'coder')) throw new Error('Remote environment unavailable');
  const config = JSON.parse(env.config) as Record<string, unknown>;
  if (env.type === 'coder') {
    const binary = typeof config.binaryPath === 'string' && config.binaryPath.trim() ? config.binaryPath.trim() : 'coder';
    if (!options.resident) return coderUsageConnection(binary, workspace);
    const token = crypto.randomBytes(16).toString('hex');
    const proc = coderResidentProcess(binary, workspace, token);
    await awaitReady(proc, token, false);
    return residentConnection(proc, () => {});
  }
  // A host that refused the credentials is not asked again until they change.
  if (isRemoteAuthFailed(environmentId)) throw new RemoteAuthError();
  const ssh = await resolveSshConfig(config);
  let connection: Awaited<ReturnType<typeof connectSshControl>>;
  try {
    connection = await connectSshControl(ssh, signal);
  } catch (error) {
    if (error instanceof Error && SSH_AUTH_REFUSED.test(error.message)) {
      markRemoteAuthFailed(environmentId);
      throw new RemoteAuthError();
    }
    throw error;
  }
  const token = crypto.randomBytes(16).toString('hex');
  const passwordSent = !!ssh.useSudo && !!ssh.password;
  try {
    const probe = await connection.spawn(buildProbeCommand(undefined, ssh.useSudo, !!ssh.password, token), { maxLineBytes: MAX_LINE_BYTES });
    // sudo -S takes exactly one line for the password; nothing else is written
    // until the reader reports ready, so a refusal consumes one attempt.
    if (passwordSent) probe.write(`${ssh.password}\n`);
    await awaitReady(probe, token, passwordSent);
    return residentConnection(probe, () => connection.end());
  } catch (error) {
    connection.end();
    if (error instanceof RemoteAuthError) markRemoteAuthFailed(environmentId);
    throw error;
  }
}

/** Recover the id from a reply the validator rejected, so its caller fails fast. */
function tryReadId(line: string): number | undefined {
  try {
    const id = (JSON.parse(line.slice(PROBE_MARKER.length)) as { id?: unknown }).id;
    return typeof id === 'number' ? id : undefined;
  } catch { return undefined; }
}
