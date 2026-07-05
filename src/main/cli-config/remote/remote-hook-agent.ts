import type { CliToolId } from '../../../shared/types';
import { quotePosixShellArg } from '../../../shared/shell-quote';
import { createLogger } from '../../logger';
import { handleConnection, type HookEventHandler, type TokenValidator } from '../hook-frame-server';
import { helperCommand, mergeClaudeSettings, scrubClaudeSettings } from '../claude-settings-overlay';
import { mergeCodexConfig, scrubCodexConfig } from '../codex-config-overlay';
import type { ControlConnection, ControlConnectionFactory, RemoteFileOps } from './control-connection';

const log = createLogger('remote-hook-agent');

/**
 * Per-environment owner of everything remote hooks need on one host: a
 * dedicated control connection (never the PTY), the uploaded helper, the
 * reverse-forwarded event socket, the merged CLI config overlays, and the
 * per-session 0600 env files. One agent serves every session on its
 * environment; per-session isolation comes from per-session tokens, not
 * per-session connections.
 *
 * Lifecycle (design doc REMOTE_HOOKS_DESIGN.md §Q4):
 *   - lazily connected by the first hooks-enabled session on the env
 *   - refcounted in memory; the last session out uninstalls the overlays and
 *     disconnects
 *   - every connect starts with a scrub pass — the remote equivalent of the
 *     local next-boot crash recovery. Between a crash and the next connect the
 *     orphaned overlay is inert: the helper exits 0 in milliseconds when its
 *     socket is gone.
 *   - a dropped control connection flips the affected sessions to
 *     cadence-only detection immediately (`setSessionHookCapable(false)`), then
 *     one reconnect attempt restores them; a second drop marks the agent
 *     failed for the boot.
 */

export interface RemoteHookAgentDeps {
  environmentId: string;
  /** Opens the control connection (ssh2 today, Coder variant in PR 3). */
  connect: ControlConnectionFactory;
  /** Local helper source, uploaded byte-for-byte to the host. */
  readHelperSource: () => string;
  /** Unique per Tether boot; namespaces the remote socket path. */
  bootId: string;
  onEvent: HookEventHandler;
  validate: TokenValidator;
  issueToken: (sessionId: string) => string;
  revokeToken: (sessionId: string) => void;
  /** Flips the status detector's per-session cadence suppression. */
  setSessionHookCapable: (sessionId: string, capable: boolean) => void;
}

interface AttachedSession {
  cliTool: 'claude' | 'codex';
  envFilePath: string;
}

type AgentState = 'idle' | 'ready' | 'failed' | 'disposed';

interface RemotePaths {
  tetherDir: string;
  binDir: string;
  helperPath: string;
  runDir: string;
  socketPath: string;
  claudeDir: string;
  claudeSettings: string;
  codexDir: string;
  codexConfig: string;
}

const RECONNECT_DELAY_MS = 3000;

/** POSIX quoting shorthand for exec command assembly. */
const q = quotePosixShellArg;

export class RemoteHookAgent {
  private conn: ControlConnection | null = null;
  private files: RemoteFileOps | null = null;
  private paths: RemotePaths | null = null;
  private state: AgentState = 'idle';
  private failReason = '';
  /** Epoch millis of the last setup failure — retry gating for the service. */
  lastFailureAt = 0;
  private setupPromise: Promise<void> | null = null;
  private readonly sessions = new Map<string, AttachedSession>();
  private claudeInstalled = false;
  private codexInstalled = false;
  /** Value for TETHER_HOOK_SOCKET: the remote UDS path, or tcp://127.0.0.1:<port>. */
  private socketEnvValue = '';
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectSpent = false;

  constructor(private readonly deps: RemoteHookAgentDeps) {}

  get currentState(): AgentState {
    return this.state;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Attach a session: ensure the host is fully set up, write the session's
   * env file, and return the env pointer for the CLI launch line. Returns `{}`
   * when this session's CLI overlay could not be installed (that CLI simply
   * stays cadence-only). Throws when host setup itself failed — callers treat
   * that as "no hooks for this env" and degrade.
   */
  async envForSession(sessionId: string, cliTool: CliToolId): Promise<Record<string, string>> {
    if (cliTool !== 'claude' && cliTool !== 'codex') return {};
    await this.ensureReady();
    if (cliTool === 'claude' && !this.claudeInstalled) return {};
    if (cliTool === 'codex' && !this.codexInstalled) return {};

    const envFilePath = `${this.paths!.runDir}/s-${sessionId}.env`;
    await this.writeSessionEnvFile(sessionId, envFilePath);
    this.sessions.set(sessionId, { cliTool, envFilePath });
    return { TETHER_HOOK_ENV_FILE: envFilePath };
  }

  /**
   * Detach a session: revoke its token, best-effort delete its env file, and
   * — when it was the last one — uninstall the overlays and disconnect.
   * No-op for sessions that never attached.
   */
  async detachSession(sessionId: string): Promise<void> {
    const attached = this.sessions.get(sessionId);
    if (!attached) return;
    this.sessions.delete(sessionId);
    this.deps.revokeToken(sessionId);
    if (this.state === 'ready' && this.files) {
      await this.files.unlink(attached.envFilePath);
    }
    if (this.sessions.size === 0 && this.state !== 'disposed') {
      await this.teardown();
    }
  }

  /** Full teardown regardless of refcount (app shutdown). Idempotent. */
  async dispose(): Promise<void> {
    if (this.state === 'disposed') return;
    for (const sessionId of this.sessions.keys()) {
      this.deps.revokeToken(sessionId);
    }
    this.sessions.clear();
    await this.teardown();
  }

  private async ensureReady(): Promise<void> {
    if (this.state === 'disposed') throw new Error('Remote hook agent disposed');
    if (this.state === 'ready') return;
    if (this.state === 'failed') throw new Error(this.failReason);
    this.setupPromise ??= this.setup().then(
      () => {
        this.state = 'ready';
      },
      (err) => {
        this.state = 'failed';
        this.failReason = err instanceof Error ? err.message : String(err);
        this.lastFailureAt = Date.now();
        this.setupPromise = null;
        this.conn?.end();
        this.conn = null;
        this.files = null;
        throw err;
      },
    );
    return this.setupPromise;
  }

  private async setup(): Promise<void> {
    const conn = await this.deps.connect();
    this.conn = conn;
    conn.onClose(() => this.handleClose(conn));

    const files = await conn.files();
    this.files = files;
    const home = await files.realpath('.');
    this.paths = buildRemotePaths(home, this.deps.bootId);
    const p = this.paths;

    // Probe platform + Node in one round-trip. The transports already assume
    // POSIX remotes; the helper additionally needs a `node` on PATH.
    const probe = await conn.exec('uname -s; command -v node || command -v nodejs || true');
    const probeLines = probe.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    const uname = probeLines[0] || '';
    const nodePath = probeLines[1] || '';
    if (uname !== 'Linux' && uname !== 'Darwin') {
      throw new Error(`Unsupported remote platform for CLI hooks: ${uname || 'unknown'}`);
    }
    if (!nodePath) {
      throw new Error('Node.js not found on host — CLI hooks unavailable, sessions stay cadence-only');
    }

    // Directories + connect-time scrub of stale run files (crashed prior
    // boots leave sockets/env files behind; sshd can also leave a stale
    // socket file that would make the re-forward bind fail).
    const dirs = await conn.exec(
      `mkdir -p ${q(p.binDir)} ${q(p.runDir)} ${q(p.claudeDir)} ${q(p.codexDir)}` +
        ` && chmod 700 ${q(p.tetherDir)} ${q(p.runDir)}` +
        ` && rm -f ${q(p.runDir)}/hook-*.sock ${q(p.runDir)}/s-*.env`,
    );
    if (dirs.code !== 0) {
      throw new Error(`Remote ~/.tether setup failed (exit ${dirs.code}): ${dirs.stderr.trim() || dirs.stdout.trim()}`);
    }

    // Helper upload — unconditional (6 KB), atomic via tmp + rename so an
    // in-flight hook invocation reading the old file is unaffected.
    const tmpPath = `${p.helperPath}.tmp-${this.deps.bootId}`;
    await files.writeFile(tmpPath, this.deps.readHelperSource(), 0o644);
    await files.rename(tmpPath, p.helperPath);

    // Reverse forward: UDS first (no TCP exposure, filesystem perms as
    // defense-in-depth), loopback TCP as the fallback when sshd forbids
    // streamlocal forwarding. Frames from either land on the same
    // stream-agnostic handler the local bridge uses.
    const onStream = (stream: Parameters<typeof handleConnection>[0]) =>
      handleConnection(stream, this.deps.onEvent, this.deps.validate);
    try {
      await conn.forwardUnix(p.socketPath, onStream);
      this.socketEnvValue = p.socketPath;
    } catch (err) {
      log.warn('Streamlocal forward failed — falling back to loopback TCP', {
        environmentId: this.deps.environmentId,
        error: err instanceof Error ? err.message : String(err),
      });
      const port = await conn.forwardTcp(onStream);
      this.socketEnvValue = `tcp://127.0.0.1:${port}`;
    }

    // Overlays install independently per CLI, mirroring the local service: a
    // broken settings.json must not cost Codex sessions their hooks (and vice
    // versa). Merge scrubs prior Tether entries first, so this pass is also
    // the overlay half of crash recovery.
    this.claudeInstalled = await this.installClaudeOverlay(files, p);
    this.codexInstalled = await this.installCodexOverlay(files, p);

    log.info('Remote hooks ready', {
      environmentId: this.deps.environmentId,
      socket: this.socketEnvValue,
      claude: this.claudeInstalled,
      codex: this.codexInstalled,
    });
  }

  private async installClaudeOverlay(files: RemoteFileOps, p: RemotePaths): Promise<boolean> {
    try {
      const text = await files.readFile(p.claudeSettings);
      // Remote hooks always cross a POSIX login shell, regardless of the
      // local platform.
      const merged = mergeClaudeSettings(text, helperCommand(p.helperPath, '--claude', 'posix'));
      await this.writeAtomic(files, p.claudeSettings, merged);
      return true;
    } catch (err) {
      // Unparseable settings.json → never overwrite mystery content (same
      // rule as local); SFTP errors (read-only home, quota) land here too.
      log.warn('Remote Claude hook install failed — Claude sessions stay cadence-only on this env', {
        environmentId: this.deps.environmentId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  private async installCodexOverlay(files: RemoteFileOps, p: RemotePaths): Promise<boolean> {
    try {
      const text = await files.readFile(p.codexConfig);
      const merged = mergeCodexConfig(text, p.helperPath);
      if (merged.changed) {
        await this.writeAtomic(files, p.codexConfig, merged.text);
      }
      return true;
    } catch (err) {
      log.warn('Remote Codex notify install failed — Codex sessions stay cadence-only on this env', {
        environmentId: this.deps.environmentId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  private async writeAtomic(files: RemoteFileOps, filePath: string, text: string): Promise<void> {
    const tmpPath = `${filePath}.tether-tmp-${this.deps.bootId}`;
    await files.writeFile(tmpPath, text, 0o600);
    await files.rename(tmpPath, filePath);
  }

  private async writeSessionEnvFile(sessionId: string, envFilePath: string): Promise<void> {
    const token = this.deps.issueToken(sessionId);
    const content = [
      `TETHER_HOOK_SOCKET=${this.socketEnvValue}`,
      `TETHER_HOOK_TOKEN=${token}`,
      `TETHER_SESSION_ID=${sessionId}`,
      '',
    ].join('\n');
    // 0600 at create; chmod again in case the server applied its umask over
    // the requested open mode.
    await this.files!.writeFile(envFilePath, content, 0o600);
    await this.files!.chmod(envFilePath, 0o600);
  }

  /**
   * Uninstall overlays, remove run files, drop the connection. The scrub is
   * best-effort — a dead connection just means the next connect's scrub pass
   * does the cleanup instead.
   */
  private async teardown(): Promise<void> {
    const wasReady = this.state === 'ready';
    this.state = 'disposed';
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const conn = this.conn;
    const files = this.files;
    const p = this.paths;
    this.conn = null;
    this.files = null;
    if (!conn) return;
    if (wasReady && files && p) {
      try {
        await this.scrubOverlays(files, p);
        await conn.exec(`rm -f ${q(p.runDir)}/hook-*.sock ${q(p.runDir)}/s-*.env`);
      } catch (err) {
        log.warn('Remote hook scrub failed during teardown — next connect will clean up', {
          environmentId: this.deps.environmentId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    conn.end();
    log.info('Remote hook agent torn down', { environmentId: this.deps.environmentId });
  }

  private async scrubOverlays(files: RemoteFileOps, p: RemotePaths): Promise<void> {
    try {
      const claudeText = await files.readFile(p.claudeSettings);
      if (claudeText !== null) {
        const scrubbed = scrubClaudeSettings(claudeText);
        if (scrubbed.changed) await this.writeAtomic(files, p.claudeSettings, scrubbed.text);
      }
    } catch (err) {
      log.warn('Remote Claude overlay scrub failed', {
        environmentId: this.deps.environmentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      const codexText = await files.readFile(p.codexConfig);
      if (codexText !== null) {
        const scrubbed = scrubCodexConfig(codexText);
        if (scrubbed.changed) await this.writeAtomic(files, p.codexConfig, scrubbed.text);
      }
    } catch (err) {
      log.warn('Remote Codex overlay scrub failed', {
        environmentId: this.deps.environmentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Unexpected connection drop. Sessions flip to cadence-only immediately so
   * they re-arm byte-level timers instead of waiting out the 10-minute hook
   * safety timeout. One reconnect attempt per drop-streak; success restores
   * capability and rewrites the env files in place (the spawned CLIs keep
   * their env-file *pointer* — which is exactly why the state lives in the
   * file, not the launch line).
   */
  private handleClose(conn: ControlConnection): void {
    if (this.conn !== conn || this.state === 'disposed') return;
    this.conn = null;
    this.files = null;
    this.setupPromise = null;
    for (const sessionId of this.sessions.keys()) {
      this.deps.setSessionHookCapable(sessionId, false);
    }
    if (this.sessions.size === 0) {
      this.state = 'failed';
      this.failReason = 'Control connection closed';
      this.lastFailureAt = Date.now();
      return;
    }
    if (this.reconnectSpent) {
      this.state = 'failed';
      this.failReason = 'Control connection lost (reconnect already attempted)';
      this.lastFailureAt = Date.now();
      log.warn('Remote hook connection lost again — sessions stay cadence-only', {
        environmentId: this.deps.environmentId,
      });
      return;
    }
    this.reconnectSpent = true;
    this.state = 'idle';
    log.warn('Remote hook connection lost — reconnecting once', { environmentId: this.deps.environmentId });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect();
    }, RECONNECT_DELAY_MS);
  }

  private async reconnect(): Promise<void> {
    if (this.state === 'disposed') return;
    try {
      await this.ensureReady();
      for (const [sessionId, attached] of this.sessions) {
        await this.writeSessionEnvFile(sessionId, attached.envFilePath);
        const installed = attached.cliTool === 'claude' ? this.claudeInstalled : this.codexInstalled;
        this.deps.setSessionHookCapable(sessionId, installed);
      }
      // A clean recovery earns the next drop its own reconnect attempt.
      this.reconnectSpent = false;
      log.info('Remote hooks restored after reconnect', { environmentId: this.deps.environmentId });
    } catch (err) {
      log.warn('Remote hook reconnect failed — sessions stay cadence-only', {
        environmentId: this.deps.environmentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function buildRemotePaths(home: string, bootId: string): RemotePaths {
  // Remote paths are always POSIX; never path.join (backslashes on win32).
  const base = `${home}/.tether`;
  return {
    tetherDir: base,
    // The path carries the `tether-cli-hook` sentinel substring, so the
    // overlay scrub recognizes remote-managed entries with zero changes.
    binDir: `${base}/bin/tether-cli-hook`,
    helperPath: `${base}/bin/tether-cli-hook/index.js`,
    runDir: `${base}/run`,
    socketPath: `${base}/run/hook-${bootId}.sock`,
    claudeDir: `${home}/.claude`,
    claudeSettings: `${home}/.claude/settings.json`,
    codexDir: `${home}/.codex`,
    codexConfig: `${home}/.codex/config.toml`,
  };
}
