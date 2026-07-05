import type { Duplex } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '' },
}));

import { RemoteHookAgent, type RemoteHookAgentDeps } from './remote-hook-agent';
import type { ControlConnection, RemoteExecResult, RemoteFileOps } from './control-connection';

const HOME = '/home/max';
const RUN_DIR = `${HOME}/.tether/run`;
const HELPER_PATH = `${HOME}/.tether/bin/tether-cli-hook/index.js`;
const CLAUDE_SETTINGS = `${HOME}/.claude/settings.json`;
const CODEX_CONFIG = `${HOME}/.codex/config.toml`;
const HELPER_SOURCE = '// tether-cli-hook helper (test build)\n';

/**
 * In-memory host: a fake ControlConnection over a Map filesystem with knobs
 * for every failure mode the agent must survive.
 */
class FakeHost {
  files = new Map<string, { content: string; mode?: number }>();
  execLog: string[] = [];
  connectCount = 0;
  ended = 0;

  // knobs
  nodePresent = true;
  uname = 'Linux';
  failUnixForward = false;
  failTcpForward = false;
  failConnectFrom = Infinity; // connect attempts >= this throw

  private closeCbs: Array<() => void> = [];
  unixForwardPath: string | null = null;

  dropConnection(): void {
    const cbs = this.closeCbs;
    this.closeCbs = [];
    for (const cb of cbs) cb();
  }

  connect = async (): Promise<ControlConnection> => {
    this.connectCount += 1;
    if (this.connectCount >= this.failConnectFrom) {
      throw new Error('connect refused (test knob)');
    }
    return this.makeConnection();
  };

  private fileOps(): RemoteFileOps {
    return {
      realpath: async (p) => (p === '.' ? HOME : p),
      readFile: async (p) => this.files.get(p)?.content ?? null,
      writeFile: async (p, data, mode) => {
        this.files.set(p, { content: data, mode });
      },
      rename: async (from, to) => {
        const entry = this.files.get(from);
        if (!entry) throw new Error(`rename: no such file ${from}`);
        this.files.delete(from);
        this.files.set(to, entry);
      },
      unlink: async (p) => {
        this.files.delete(p);
      },
      chmod: async (p, mode) => {
        const entry = this.files.get(p);
        if (entry) entry.mode = mode;
      },
    };
  }

  private makeConnection(): ControlConnection {
    return {
      exec: async (cmd): Promise<RemoteExecResult> => {
        this.execLog.push(cmd);
        if (cmd.startsWith('uname')) {
          const lines = [this.uname];
          if (this.nodePresent) lines.push('/usr/bin/node');
          return { code: 0, stdout: lines.join('\n') + '\n', stderr: '' };
        }
        if (cmd.startsWith('rm -f')) {
          // Emulate the run-file scrub for teardown assertions.
          for (const key of Array.from(this.files.keys())) {
            if (key.startsWith(`${RUN_DIR}/hook-`) || key.startsWith(`${RUN_DIR}/s-`)) {
              this.files.delete(key);
            }
          }
        }
        return { code: 0, stdout: '', stderr: '' };
      },
      files: async () => this.fileOps(),
      forwardUnix: async (socketPath) => {
        if (this.failUnixForward) throw new Error('streamlocal forwarding disabled (test knob)');
        this.unixForwardPath = socketPath;
      },
      forwardTcp: async () => {
        if (this.failTcpForward) throw new Error('tcp forwarding disabled (test knob)');
        return 45678;
      },
      onClose: (cb) => {
        this.closeCbs.push(cb);
      },
      end: () => {
        this.ended += 1;
      },
    };
  }
}

interface Harness {
  host: FakeHost;
  agent: RemoteHookAgent;
  revoked: string[];
  capabilityFlips: Array<[string, boolean]>;
}

function makeHarness(overrides: Partial<RemoteHookAgentDeps> = {}): Harness {
  const host = new FakeHost();
  const revoked: string[] = [];
  const capabilityFlips: Array<[string, boolean]> = [];
  const agent = new RemoteHookAgent({
    environmentId: 'env-1',
    connect: host.connect,
    readHelperSource: () => HELPER_SOURCE,
    bootId: 'boot01',
    onEvent: () => {},
    validate: () => true,
    issueToken: (sid) => `token-${sid}`,
    revokeToken: (sid) => revoked.push(sid),
    setSessionHookCapable: (sid, capable) => capabilityFlips.push([sid, capable]),
    ...overrides,
  });
  return { host, agent, revoked, capabilityFlips };
}

function fileContent(host: FakeHost, p: string): string {
  const entry = host.files.get(p);
  expect(entry, `expected remote file ${p}`).toBeDefined();
  return entry!.content;
}

describe('RemoteHookAgent setup', () => {
  it('uploads the helper, installs both overlays, and returns an env-file pointer', async () => {
    const { host, agent } = makeHarness();
    const env = await agent.envForSession('s1', 'claude');

    expect(env).toEqual({ TETHER_HOOK_ENV_FILE: `${RUN_DIR}/s-s1.env` });
    expect(fileContent(host, HELPER_PATH)).toBe(HELPER_SOURCE);

    const envFile = host.files.get(`${RUN_DIR}/s-s1.env`)!;
    expect(envFile.mode).toBe(0o600);
    expect(envFile.content).toContain(`TETHER_HOOK_SOCKET=${RUN_DIR}/hook-boot01.sock`);
    expect(envFile.content).toContain('TETHER_HOOK_TOKEN=token-s1');
    expect(envFile.content).toContain('TETHER_SESSION_ID=s1');
    expect(host.unixForwardPath).toBe(`${RUN_DIR}/hook-boot01.sock`);

    const settings = JSON.parse(fileContent(host, CLAUDE_SETTINGS)) as {
      hooks: { Notification: unknown[]; Stop: unknown[] };
    };
    expect(settings.hooks.Notification).toHaveLength(1);
    expect(settings.hooks.Stop).toHaveLength(1);
    // POSIX-quoted helper command regardless of the local platform.
    expect(JSON.stringify(settings)).toContain(`node '${HELPER_PATH}' --claude`);
    expect(fileContent(host, CODEX_CONFIG)).toContain(`notify = ["node", "${HELPER_PATH}", "--codex"]`);
  });

  it('returns {} for CLIs without hook support and does not attach them', async () => {
    const { host, agent } = makeHarness();
    expect(await agent.envForSession('s1', 'opencode')).toEqual({});
    expect(await agent.envForSession('s2', 'custom')).toEqual({});
    expect(host.connectCount).toBe(0);
    expect(agent.sessionCount).toBe(0);
  });

  it('fails setup when Node.js is missing on the host', async () => {
    const { host, agent } = makeHarness();
    host.nodePresent = false;
    await expect(agent.envForSession('s1', 'claude')).rejects.toThrow(/Node\.js not found/);
    expect(agent.currentState).toBe('failed');
    expect(agent.sessionCount).toBe(0);
  });

  it('fails setup on non-POSIX remotes', async () => {
    const { host, agent } = makeHarness();
    host.uname = 'MSYS_NT-10.0';
    await expect(agent.envForSession('s1', 'claude')).rejects.toThrow(/Unsupported remote platform/);
  });

  it('falls back to a loopback TCP forward when streamlocal is forbidden', async () => {
    const { host, agent } = makeHarness();
    host.failUnixForward = true;
    await agent.envForSession('s1', 'codex');
    expect(fileContent(host, `${RUN_DIR}/s-s1.env`)).toContain('TETHER_HOOK_SOCKET=tcp://127.0.0.1:45678');
  });

  it('never overwrites an unparseable settings.json — Claude degrades, Codex still installs', async () => {
    const { host, agent } = makeHarness();
    const mangled = '{ this is not json';
    host.files.set(CLAUDE_SETTINGS, { content: mangled });

    expect(await agent.envForSession('s1', 'claude')).toEqual({});
    expect(fileContent(host, CLAUDE_SETTINGS)).toBe(mangled);

    const env = await agent.envForSession('s2', 'codex');
    expect(env.TETHER_HOOK_ENV_FILE).toBe(`${RUN_DIR}/s-s2.env`);
    expect(fileContent(host, CODEX_CONFIG)).toContain('tether-cli-hook');
  });

  it('reuses one control connection for many sessions', async () => {
    const { host, agent } = makeHarness();
    await agent.envForSession('s1', 'claude');
    await agent.envForSession('s2', 'claude');
    await agent.envForSession('s3', 'codex');
    expect(host.connectCount).toBe(1);
    expect(agent.sessionCount).toBe(3);
  });
});

describe('RemoteHookAgent refcount + teardown', () => {
  it('keeps overlays while sessions remain, scrubs everything after the last detach', async () => {
    const { host, agent, revoked } = makeHarness();
    await agent.envForSession('s1', 'claude');
    await agent.envForSession('s2', 'codex');

    await agent.detachSession('s1');
    expect(revoked).toEqual(['s1']);
    expect(host.files.has(`${RUN_DIR}/s-s1.env`)).toBe(false);
    expect(fileContent(host, CLAUDE_SETTINGS)).toContain('tether-cli-hook');
    expect(host.ended).toBe(0);

    await agent.detachSession('s2');
    expect(fileContent(host, CLAUDE_SETTINGS)).not.toContain('tether-cli-hook');
    expect(fileContent(host, CODEX_CONFIG)).not.toContain('tether-cli-hook');
    expect(host.files.has(`${RUN_DIR}/s-s2.env`)).toBe(false);
    expect(host.ended).toBe(1);
    expect(agent.currentState).toBe('disposed');
  });

  it('detach is a no-op for sessions that never attached', async () => {
    const { host, agent } = makeHarness();
    await agent.detachSession('ghost');
    expect(host.connectCount).toBe(0);
    expect(agent.currentState).toBe('idle');
  });

  it('dispose revokes every session token and scrubs the host', async () => {
    const { host, agent, revoked } = makeHarness();
    await agent.envForSession('s1', 'claude');
    await agent.envForSession('s2', 'codex');
    await agent.dispose();
    expect(revoked.sort()).toEqual(['s1', 's2']);
    expect(fileContent(host, CLAUDE_SETTINGS)).not.toContain('tether-cli-hook');
    expect(host.ended).toBe(1);
    // Idempotent.
    await agent.dispose();
    expect(host.ended).toBe(1);
  });
});

describe('RemoteHookAgent reconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('flips sessions to cadence-only on drop and restores them after a successful reconnect', async () => {
    const { host, agent, capabilityFlips } = makeHarness();
    await agent.envForSession('s1', 'claude');

    host.dropConnection();
    expect(capabilityFlips).toEqual([['s1', false]]);

    await vi.advanceTimersByTimeAsync(3000);
    expect(host.connectCount).toBe(2);
    expect(capabilityFlips).toEqual([['s1', false], ['s1', true]]);
    // Env file rewritten in place — the running CLI keeps its pointer.
    expect(fileContent(host, `${RUN_DIR}/s-s1.env`)).toContain('TETHER_HOOK_TOKEN=token-s1');
    expect(agent.currentState).toBe('ready');
  });

  it('marks the agent failed when the reconnect attempt also fails', async () => {
    const { host, agent, capabilityFlips } = makeHarness();
    await agent.envForSession('s1', 'claude');

    host.failConnectFrom = 2;
    host.dropConnection();
    await vi.advanceTimersByTimeAsync(3000);

    expect(agent.currentState).toBe('failed');
    expect(capabilityFlips).toEqual([['s1', false]]);
  });
});
