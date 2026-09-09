import { spawn } from 'node:child_process';
import { quotePosixShellArg as q } from '../../shared/shell-quote';
import { getEnvironment } from '../db/environment-repo';
import { resolveSshConfig } from '../ssh/resolve-ssh-config';
import { connectSshControl } from '../cli-config/remote/ssh-control-connection';
import { REMOTE_USAGE_PROBE } from './remote-probe';
import type { RemoteUsageReply, RemoteUsageRequest } from './remote-protocol';

const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

export interface RemoteUsageConnection {
  poll(request: RemoteUsageRequest): Promise<RemoteUsageReply>;
  close(): void;
}

export function buildProbeCommand(request: RemoteUsageRequest, sudo = false, password = false): string {
  const encoded = Buffer.from(JSON.stringify(request)).toString('base64');
  // Encode the bundled program as well as the request. This keeps multiline
  // JavaScript out of nested shell/Windows argument quoting. Only our static
  // program is evaluated; request data is decoded with JSON.parse by the probe.
  const program = Buffer.from(REMOTE_USAGE_PROBE).toString('base64');
  const bootstrap = `eval(Buffer.from('${program}', 'base64').toString('utf8'))`;
  const command = `exec "$(command -v node || command -v nodejs)" -e ${q(bootstrap)} ${q(encoded)}`;
  // Login-shell context matches the CLI's home/PATH. The only password input,
  // when needed, travels over encrypted stdin, never argv/history/logs.
  const shell = `sh -lc ${q(command)}`;
  return sudo ? `sudo ${password ? "-S -p ''" : '-n'} -i -- ${shell}` : shell;
}

export function parseProbeReply(stdout: string): RemoteUsageReply {
  const line = stdout.split('\n').findLast(l => l.startsWith('__TETHER_USAGE__'));
  if (!line) throw new Error('Remote usage reader unavailable');
  const reply = JSON.parse(line.slice('__TETHER_USAGE__'.length)) as RemoteUsageReply;
  if (reply.status === 'pending') return { status: 'pending' };
  const s = reply.source;
  if (reply.status !== 'ready' || !s || [s.path, s.scope, s.nativeSessionId, s.identity].some(v => typeof v !== 'string' || v.length > 8192)) {
    throw new Error('Invalid remote usage reply');
  }
  if (reply.offset !== undefined && (!Number.isSafeInteger(reply.offset) || reply.offset < 0 || typeof reply.text !== 'string' || typeof reply.reset !== 'boolean')) {
    throw new Error('Invalid remote usage cursor');
  }
  return reply;
}

/** A separate, non-PTY command process; Coder owns its authenticated tunnel. */
export function coderUsageConnection(binary: string, workspace: string): RemoteUsageConnection {
  const children = new Set<ReturnType<typeof spawn>>();
  let closed = false;
  return {
    poll: request => new Promise((resolve, reject) => {
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
    }),
    close: () => {
      closed = true;
      for (const child of children) child.kill();
      children.clear();
    },
  };
}

export async function connectRemoteUsage(environmentId: string, workspace: string, signal?: AbortSignal): Promise<RemoteUsageConnection> {
  const env = getEnvironment(environmentId);
  if (!env || (env.type !== 'ssh' && env.type !== 'coder')) throw new Error('Remote environment unavailable');
  const config = JSON.parse(env.config) as Record<string, unknown>;
  if (env.type === 'coder') {
    return coderUsageConnection(typeof config.binaryPath === 'string' && config.binaryPath.trim() ? config.binaryPath.trim() : 'coder', workspace);
  }
  const ssh = await resolveSshConfig(config);
  const connection = await connectSshControl(ssh, signal);
  return {
    poll: async request => {
      const result = await connection.exec(buildProbeCommand(request, ssh.useSudo, !!ssh.password), {
        input: ssh.useSudo && ssh.password ? `${ssh.password}\n` : undefined,
        timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES,
      });
      if (result.code !== 0) throw new Error('Remote usage reader unavailable');
      return parseProbeReply(result.stdout);
    },
    close: () => connection.end(),
  };
}
