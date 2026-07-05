import type { CliToolId } from '../../../shared/types';
import { quotePosixShellArg } from '../../../shared/shell-quote';
import { createLogger } from '../../logger';
import { handleConnection, type HookEventHandler, type TokenValidator } from '../hook-frame-server';
import { helperCommand, mergeClaudeSettings, scrubClaudeSettings } from '../claude-settings-overlay';
import { mergeCodexConfig, scrubCodexConfig } from '../codex-config-overlay';
import { SENTINEL_TOKEN } from '../overlay-common';
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
 *     disconnects. A teardown that arrives while another session's attach is
 *     still in flight is deferred until the attach settles.
 *   - every connect scrubs this boot's stale socket and ages out leftovers of
 *     crashed prior boots — never fresh files, which may belong to another
 *     live Tether instance on the same host/user.
 *   - a dropped control connection flips the affected sessions to
 *     cadence-only detection immediately (`setSessionHookCapable(false)`),
 *     then one reconnect attempt restores them; a second drop marks the agent
 *     failed for the boot. An `epoch` counter fences every async setup step so
 *     a drop mid-setup can't resurrect state or kill a successor connection.
 *   - if the connection is already gone when the last session detaches, the
 *     host keeps its (inert — the helper exits 0 in milliseconds without its
 *     socket) overlay entries until the next connect's scrub, exactly like the
 *     local feature's crash-recovery window.
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

/** CLIs whose hooks the remote overlays can drive. */
type HookCli = 'claude' | 'codex';

interface AttachedSession {
  cliTool: HookCli;
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

/** Age (minutes) after which leftover run files from crashed boots are swept. */
const STALE_RUN_FILE_MINUTES = 24 * 60;

// Shell probe marker: hosts whose non-interactive shells echo rc/motd noise
// would otherwise shift the positional parse of the probe output.
const PROBE_MARKER = '__TETHER_PROBE__';

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
  /**
   * Fences async setup steps against connection loss/teardown: bumped by
   * `handleClose` and `teardown`, checked after every await in `setup` and in
   * the settle handlers, so a superseded setup can neither mutate agent state
   * nor end a successor's connection.
   */
  private epoch = 0;
  private readonly sessions = new Map<string, AttachedSession>();
  /** Attaches past the CLI gate but not yet in `sessions` (see detach deferral). */
  private pendingAttaches = 0;
  private teardownRequested = false;
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
    this.pendingAttaches += 1;
    try {
      await this.ensureReady();
      if (!this.cliInstalled(cliTool)) return {};
      const files = this.files;
      if (!files) throw new Error('Control connection lost during session attach');
      const envFilePath = this.envFilePathFor(sessionId);
      await this.writeSessionEnvFile(files, sessionId, envFilePath);
      this.sessions.set(sessionId, { cliTool, envFilePath });
      return { TETHER_HOOK_ENV_FILE: envFilePath };
    } finally {
      this.pendingAttaches -= 1;
      this.runDeferredTeardown();
    }
  }

  /**
   * Detach a session: revoke its token, best-effort delete its env file, and
   * — when it was the last one — uninstall the overlays and disconnect. If
   * another session's attach is still in flight, the teardown is deferred
   * until that attach settles (a mid-write teardown would strand it).
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
      if (this.pendingAttaches > 0) {
        this.teardownRequested = true;
        return;
      }
      await this.teardown();
    }
  }

  /** Full teardown regardless of refcount (app shutdown). Idempotent. */
  async dispose(): Promise<void> {
    if (this.state === 'disposed') return;
    for (const sessionId of this.sessions.keys()) {
      this.deps.revokeToken(sessionId);
    }
    // Teardown before clearing: it removes the remaining sessions' env files.
    await this.teardown();
    this.sessions.clear();
  }

  private cliInstalled(cliTool: HookCli): boolean {
    return cliTool === 'claude' ? this.claudeInstalled : this.codexInstalled;
  }

  private envFilePathFor(sessionId: string): string {
    // Naming is mirrored by the stale-file sweep glob in setup() — keep in sync.
    return `${this.paths!.runDir}/s-${sessionId}.env`;
  }

  private runDeferredTeardown(): void {
    if (!this.teardownRequested || this.pendingAttaches > 0) return;
    if (this.sessions.size > 0 || this.state === 'disposed') {
      this.teardownRequested = false;
      return;
    }
    this.teardownRequested = false;
    this.teardown().catch((err) => {
      log.warn('Deferred remote hook teardown failed', {
        environmentId: this.deps.environmentId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  private async ensureReady(): Promise<void> {
    if (this.state === 'disposed') throw new Error('Remote hook agent disposed');
    if (this.state === 'ready') return;
    if (this.state === 'failed') throw new Error(this.failReason);
    if (!this.setupPromise) {
      const attempt = this.epoch;
      this.setupPromise = this.setup(attempt).then(
        () => {
          if (this.epoch !== attempt || this.state === 'disposed') {
            throw new Error('Remote hook setup superseded by connection loss');
          }
          this.state = 'ready';
        },
        (err) => {
          if (this.epoch === attempt && this.state !== 'disposed') {
            this.state = 'failed';
            this.failReason = err instanceof Error ? err.message : String(err);
            this.lastFailureAt = Date.now();
            this.setupPromise = null;
            this.conn?.end();
            this.conn = null;
            this.files = null;
          }
          throw err;
        },
      );
    }
    return this.setupPromise;
  }

  /** Throws when this setup attempt was superseded (drop/teardown mid-setup). */
  private assertCurrent(attempt: number): void {
    if (this.epoch !== attempt || this.state === 'disposed') {
      throw new Error('Remote hook setup superseded');
    }
  }

  private async setup(attempt: number): Promise<void> {
    const conn = await this.deps.connect();
    if (this.epoch !== attempt || this.state === 'disposed') {
      conn.end();
      throw new Error('Remote hook setup superseded');
    }
    this.conn = conn;
    conn.onClose(() => this.handleClose(conn));

    const files = await conn.files();
    this.assertCurrent(attempt);
    this.files = files;
    const home = await files.realpath('.');
    this.assertCurrent(attempt);
    this.paths = buildRemotePaths(home, this.deps.bootId);
    const p = this.paths;

    // Probe platform + Node in one round-trip. The transports already assume
    // POSIX remotes; the helper additionally needs a `node` on PATH. The
    // marker discards any rc/motd noise the non-interactive shell emits.
    const probe = await conn.exec(`echo ${PROBE_MARKER}; uname -s; command -v node || command -v nodejs || true`);
    this.assertCurrent(attempt);
    const probeLines = probe.stdout.split('\n').map((l) => l.trim());
    const markerIdx = probeLines.indexOf(PROBE_MARKER);
    const uname = (markerIdx >= 0 && probeLines[markerIdx + 1]) || '';
    const nodePath = (markerIdx >= 0 && probeLines[markerIdx + 2]) || '';
    if (uname !== 'Linux' && uname !== 'Darwin') {
      throw new Error(`Unsupported remote platform for CLI hooks: ${uname || 'unknown'}`);
    }
    if (!nodePath) {
      throw new Error('Node.js not found on host — CLI hooks unavailable, sessions stay cadence-only');
    }

    const dirs = await conn.exec(
      `mkdir -p ${q(p.binDir)} ${q(p.runDir)} ${q(p.claudeDir)} ${q(p.codexDir)}` +
        ` && chmod 700 ${q(p.tetherDir)} ${q(p.runDir)}`,
    );
    this.assertCurrent(attempt);
    if (dirs.code !== 0) {
      throw new Error(`Remote ~/.tether setup failed (exit ${dirs.code}): ${dirs.stderr.trim() || dirs.stdout.trim()}`);
    }

    // Connect-time scrub: remove THIS boot's stale socket (sshd can leave the
    // inode behind, which would fail the re-bind) and age out run files from
    // crashed prior boots. Deliberately no fresh-file globbing — another live
    // Tether instance's socket and env files share this directory.
    await files.unlink(p.socketPath);
    await conn.exec(
      `find ${q(p.runDir)} -maxdepth 1 -type f \\( -name 'hook-*.sock' -o -name 's-*.env' \\)` +
        ` -mmin +${STALE_RUN_FILE_MINUTES} -delete 2>/dev/null || true`,
    );
    this.assertCurrent(attempt);

    // Helper upload — unconditional (6 KB), atomic via tmp + rename so an
    // in-flight hook invocation reading the old file is unaffected.
    const tmpPath = `${p.helperPath}.tmp-${this.deps.bootId}`;
    await files.writeFile(tmpPath, this.deps.readHelperSource(), 0o644);
    this.assertCurrent(attempt);
    await files.rename(tmpPath, p.helperPath);
    this.assertCurrent(attempt);

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
      this.assertCurrent(attempt);
      log.warn('Streamlocal forward failed — falling back to loopback TCP', {
        environmentId: this.deps.environmentId,
        error: err instanceof Error ? err.message : String(err),
      });
      const port = await conn.forwardTcp(onStream);
      this.socketEnvValue = `tcp://127.0.0.1:${port}`;
    }
    this.assertCurrent(attempt);

    // Overlays install independently per CLI, mirroring the local service: a
    // broken settings.json must not cost Codex sessions their hooks (and vice
    // versa). Merge scrubs prior Tether entries first, so this pass is also
    // the overlay half of crash recovery. If NEITHER file could be updated
    // the host can never serve hooks — fail setup so the connection is not
    // kept alive for nothing.
    const [claudeOk, codexOk] = await Promise.all([
      this.applyOverlay(
        files,
        p.claudeSettings,
        (text) => ({ text: mergeClaudeSettings(text, helperCommand(p.helperPath, '--claude', 'posix')), changed: true }),
        'Claude hook install failed — Claude sessions stay cadence-only on this env',
      ),
      this.applyOverlay(
        files,
        p.codexConfig,
        (text) => mergeCodexConfig(text, p.helperPath),
        'Codex notify install failed — Codex sessions stay cadence-only on this env',
      ),
    ]);
    this.assertCurrent(attempt);
    this.claudeInstalled = claudeOk;
    this.codexInstalled = codexOk;
    if (!claudeOk && !codexOk) {
      throw new Error('Neither ~/.claude/settings.json nor ~/.codex/config.toml could be updated on the host');
    }

    log.info('Remote hooks ready', {
      environmentId: this.deps.environmentId,
      socket: this.socketEnvValue,
      claude: this.claudeInstalled,
      codex: this.codexInstalled,
    });
  }

  /**
   * Read → transform → atomic-write one remote CLI config file. Returns false
   * (logged) on any failure — unparseable existing content throws inside the
   * transform and lands here too, honoring the never-overwrite-mystery rule.
   */
  private async applyOverlay(
    files: RemoteFileOps,
    filePath: string,
    transform: (text: string | null) => { text: string; changed: boolean },
    failureLabel: string,
  ): Promise<boolean> {
    try {
      const result = transform(await files.readFile(filePath));
      if (result.changed) {
        await this.writeAtomic(files, filePath, result.text);
      }
      return true;
    } catch (err) {
      log.warn(`Remote ${failureLabel}`, {
        environmentId: this.deps.environmentId,
        filePath,
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

  private async writeSessionEnvFile(files: RemoteFileOps, sessionId: string, envFilePath: string): Promise<void> {
    const token = this.deps.issueToken(sessionId);
    const content = [
      `TETHER_HOOK_SOCKET=${this.socketEnvValue}`,
      `TETHER_HOOK_TOKEN=${token}`,
      `TETHER_SESSION_ID=${sessionId}`,
      '',
    ].join('\n');
    // 0600 at create; chmod again in case the server applied its umask over
    // the requested open mode.
    await files.writeFile(envFilePath, content, 0o600);
    await files.chmod(envFilePath, 0o600);
  }

  /**
   * Uninstall overlays, remove this agent's run files, drop the connection.
   * The scrub is best-effort — and when the connection is already gone, the
   * host keeps its inert entries until the next connect's scrub, the same
   * window the local feature accepts after a crash.
   */
  private async teardown(): Promise<void> {
    const wasReady = this.state === 'ready';
    this.state = 'disposed';
    this.epoch += 1;
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
        for (const attached of this.sessions.values()) {
          await files.unlink(attached.envFilePath);
        }
        await files.unlink(p.socketPath);
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
    await Promise.all([
      this.applyOverlay(files, p.claudeSettings, scrubClaudeSettings, 'Claude overlay scrub failed'),
      this.applyOverlay(files, p.codexConfig, scrubCodexConfig, 'Codex overlay scrub failed'),
    ]);
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
    this.epoch += 1;
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
      const files = this.files;
      if (!files) throw new Error('Control connection lost again during reconnect');
      for (const [sessionId, attached] of this.sessions) {
        await this.writeSessionEnvFile(files, sessionId, attached.envFilePath);
        this.deps.setSessionHookCapable(sessionId, this.cliInstalled(attached.cliTool));
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
    // Composed from SENTINEL_TOKEN so the helper path always carries the
    // substring the overlay scrub matches remote-managed entries by.
    binDir: `${base}/bin/${SENTINEL_TOKEN}`,
    helperPath: `${base}/bin/${SENTINEL_TOKEN}/index.js`,
    runDir: `${base}/run`,
    socketPath: `${base}/run/hook-${bootId}.sock`,
    claudeDir: `${home}/.claude`,
    claudeSettings: `${home}/.claude/settings.json`,
    codexDir: `${home}/.codex`,
    codexConfig: `${home}/.codex/config.toml`,
  };
}
