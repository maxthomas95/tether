import { v4 as uuidv4 } from 'uuid';
import { safeStorage } from 'electron';
import { LocalTransport } from '../transport/local-transport';
import { SSHTransport } from '../transport/ssh-transport';
import type { SessionTransport } from '../transport/types';
import type { SSHConfig } from '../transport/ssh-transport';
import { statusDetector } from '../status/status-detector';
import { getEnvironment } from '../db/environment-repo';
import { isVaultRef, resolveRef, resolveAll } from '../vault/vault-resolver';
import { transcriptExists } from '../claude/transcripts';
import type { SessionState, SessionInfo, CreateSessionOptions } from '../../shared/types';

export interface SessionCallbacks {
  onData(sessionId: string, data: string): void;
  onStateChange(sessionId: string, state: SessionState): void;
  onExit(sessionId: string, exitCode: number): void;
}

export class Session {
  readonly id: string;
  label: string;
  readonly workingDir: string;
  readonly environmentId: string | null;
  readonly createdAt: string;
  state: SessionState = 'starting';
  transport: SessionTransport | null = null;
  /** UUID we passed to `claude --session-id` (or `--resume`). */
  claudeSessionId: string | null = null;
  /** True when this session was launched via `--resume`. */
  resumed = false;

  constructor(id: string, label: string, workingDir: string, environmentId?: string) {
    this.id = id;
    this.label = label;
    this.workingDir = workingDir;
    this.environmentId = environmentId || null;
    this.createdAt = new Date().toISOString();
  }

  toInfo(): SessionInfo {
    return {
      id: this.id,
      environmentId: this.environmentId,
      label: this.label,
      workingDir: this.workingDir,
      state: this.state,
      createdAt: this.createdAt,
      claudeSessionId: this.claudeSessionId || undefined,
      resumed: this.resumed || undefined,
    };
  }
}

async function createTransport(environmentId?: string): Promise<SessionTransport> {
  if (!environmentId) return new LocalTransport();

  const env = getEnvironment(environmentId);
  if (!env || env.type === 'local') return new LocalTransport();

  if (env.type === 'ssh') {
    const raw = JSON.parse(env.config) as Record<string, unknown>;
    // Resolve password: vault ref → resolved string, encrypted-at-rest → decrypted string
    let password = raw.password as string | undefined;
    if (typeof password === 'string' && isVaultRef(password)) {
      // Vault refs are stored as-is (encryptConfigPassword leaves them alone)
      password = await resolveRef(password);
    } else if (raw.passwordEncrypted && typeof password === 'string' && safeStorage.isEncryptionAvailable()) {
      password = safeStorage.decryptString(Buffer.from(password, 'base64'));
    }
    const config = raw as Partial<SSHConfig>;
    return new SSHTransport({
      host: config.host || 'localhost',
      port: config.port || 22,
      username: config.username || 'root',
      privateKeyPath: config.privateKeyPath,
      useAgent: config.useAgent ?? (!config.privateKeyPath && !password),
      password,
    });
  }

  // Coder: will use SSH-via-Coder-CLI approach (Phase 7)
  return new LocalTransport();
}

class SessionManager {
  private sessions = new Map<string, Session>();
  private callbacksMap = new Map<string, SessionCallbacks>();

  constructor() {
    statusDetector.onStateChange((sessionId, state) => {
      const session = this.sessions.get(sessionId);
      if (session) {
        session.state = state;
        this.callbacksMap.get(sessionId)?.onStateChange(sessionId, state);
      }
    });
  }

  async createSession(
    opts: CreateSessionOptions,
    callbacks: SessionCallbacks,
  ): Promise<Session> {
    const id = uuidv4();
    const label = opts.label || opts.workingDir.split(/[\\/]/).pop() || 'Untitled';
    const session = new Session(id, label, opts.workingDir, opts.environmentId);
    this.sessions.set(id, session);
    this.callbacksMap.set(id, callbacks);

    statusDetector.register(id);

    let transport: SessionTransport;
    try {
      transport = await createTransport(opts.environmentId);
    } catch (err) {
      // Resolution failed (e.g. vault ref couldn't be fetched). Tear down the
      // half-initialized session and bubble the error to the caller.
      statusDetector.unregister(id);
      this.sessions.delete(id);
      this.callbacksMap.delete(id);
      throw err;
    }
    session.transport = transport;

    transport.onData((data: string) => {
      statusDetector.feedData(id, data);
      callbacks.onData(id, data);
    });

    transport.onExit(({ exitCode }) => {
      if (!session.transport) return;
      statusDetector.markExited(id, exitCode);
      session.transport = null;
      callbacks.onExit(id, exitCode);
    });

    // Resolve env var cascade: app defaults -> environment -> session override
    const { getDb } = await import('../db/database');
    const appEnvVars = getDb().defaultEnvVars;
    let envEnvVars: Record<string, string> = {};
    if (opts.environmentId) {
      const envRow = getEnvironment(opts.environmentId);
      if (envRow?.env_vars) {
        try { envEnvVars = JSON.parse(envRow.env_vars); } catch { /* ignore */ }
      }
    }
    const mergedEnv: Record<string, string> = {
      ...appEnvVars,
      ...envEnvVars,
      ...(opts.env || {}),
    };

    // Resolve any vault:// refs in the merged env. Failure aborts the session.
    let resolvedEnv: Record<string, string>;
    try {
      resolvedEnv = await resolveAll(mergedEnv);
    } catch (err) {
      statusDetector.unregister(id);
      transport.dispose();
      this.sessions.delete(id);
      this.callbacksMap.delete(id);
      throw err;
    }

    // Resolve CLI flags: app defaults + session-specific
    const appCliFlags = getDb().defaultCliFlags || [];
    const resolvedCliArgs = [...appCliFlags, ...(opts.cliArgs || [])];

    // Decide on the Claude session UUID. We only manage this for local
    // sessions — SSH/Coder transports don't currently understand the flag and
    // we can't safely verify the remote JSONL exists before resuming.
    let claudeSessionId: string | undefined;
    let resumeId: string | undefined;
    if (transport instanceof LocalTransport) {
      if (opts.resumeClaudeSessionId && transcriptExists(opts.workingDir, opts.resumeClaudeSessionId)) {
        // Resume the existing transcript and reuse the same id going forward.
        resumeId = opts.resumeClaudeSessionId;
        claudeSessionId = opts.resumeClaudeSessionId;
        session.resumed = true;
      } else {
        // Fresh session — pin a new id so we can resume it next launch.
        claudeSessionId = uuidv4();
      }
      session.claudeSessionId = claudeSessionId;
    }

    await transport.start({
      workingDir: opts.workingDir,
      env: resolvedEnv,
      cols: 120,
      rows: 30,
      cliArgs: resolvedCliArgs.length > 0 ? resolvedCliArgs : undefined,
      claudeSessionId,
      resumeClaudeSessionId: resumeId,
    });

    return session;
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  listSessions(): Session[] {
    return Array.from(this.sessions.values());
  }

  renameSession(id: string, label: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.label = label;
    }
  }

  removeSession(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      statusDetector.unregister(id);
      session.transport?.dispose();
      this.sessions.delete(id);
      this.callbacksMap.delete(id);
    }
  }

  writeToSession(id: string, data: string): void {
    this.sessions.get(id)?.transport?.write(data);
  }

  resizeSession(id: string, cols: number, rows: number): void {
    this.sessions.get(id)?.transport?.resize(cols, rows);
  }

  async stopSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session?.transport) {
      await session.transport.stop();
    }
  }

  killSession(id: string): void {
    const session = this.sessions.get(id);
    if (session?.transport) {
      session.transport.kill();
      session.transport = null;
      statusDetector.markExited(id, 1);
    }
  }

  dispose(): void {
    statusDetector.dispose();
    for (const session of this.sessions.values()) {
      session.transport?.dispose();
    }
    this.sessions.clear();
    this.callbacksMap.clear();
  }
}

export const sessionManager = new SessionManager();
