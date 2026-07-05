import fs from 'node:fs';
import crypto from 'node:crypto';
import { getEnvironment } from '../../db/environment-repo';
import { getDb, type EnvironmentRow } from '../../db/database';
import { statusDetector } from '../../status/status-detector';
import { getHookBridge, getHelperPath } from '../hook-service';
import { resolveSshConfig } from '../../ssh/resolve-ssh-config';
import { createLogger } from '../../logger';
import type { CliToolId } from '../../../shared/types';
import { connectSshControl } from './ssh-control-connection';
import { RemoteHookAgent } from './remote-hook-agent';

const log = createLogger('remote-hook-service');

/**
 * Registry of per-environment RemoteHookAgents, plus the consent gating that
 * decides whether a session gets remote hooks at all. Consulted from
 * `createSession` for environment-backed sessions; torn down from
 * `removeSession` (per session) and app shutdown (all agents).
 *
 * Gating (all must hold — REMOTE_HOOKS_DESIGN.md §Q5):
 *   - global `cliHooksEnabled === 'true'` AND the local bridge is running
 *   - environment type is `ssh` (Coder lands in PR 3)
 *   - the environment opted in: `config.remoteCliHooks === true` (default off —
 *     writing dotfiles on another machine is opt-in per host)
 *   - not a `useSudo` environment (the CLI runs as root; root's dotfiles are
 *     out of reach of the login-user control connection — v1 skips these)
 *   - the CLI is hook-capable (claude / codex)
 */

/** Hard cap on how long a session launch waits for host setup. */
const ENV_SETUP_TIMEOUT_MS = 8000;

/** A failed agent may be retried by a fresh session after this cooldown. */
const RETRY_COOLDOWN_MS = 60_000;

// Namespaces the remote socket path per Tether boot, so two instances (or a
// crashed predecessor's leftovers) never collide on one host.
const bootId = crypto.randomBytes(4).toString('hex');

const agents = new Map<string, RemoteHookAgent>();

// One warn per environment per boot — a host with no Node.js would otherwise
// log on every session start.
const failureLogged = new Set<string>();

/** Pure consent gate — exported for tests. */
export function remoteHooksEligible(
  envType: string,
  config: Record<string, unknown>,
  cliTool: CliToolId,
): boolean {
  if (envType !== 'ssh') return false;
  if (config.remoteCliHooks !== true) return false;
  if (config.useSudo) return false;
  return cliTool === 'claude' || cliTool === 'codex';
}

function getOrCreateAgent(environmentId: string): RemoteHookAgent {
  const existing = agents.get(environmentId);
  if (existing) {
    const retryEligible =
      existing.currentState === 'failed' &&
      existing.sessionCount === 0 &&
      Date.now() - existing.lastFailureAt > RETRY_COOLDOWN_MS;
    if (existing.currentState !== 'disposed' && !retryEligible) return existing;
    // Replace dead/cooled-down agents so a transient failure doesn't cost the
    // whole boot. Old failed agents hold no connection — nothing to dispose.
    failureLogged.delete(environmentId);
  }

  const bridge = getHookBridge();
  if (!bridge) throw new Error('Hook bridge is not running');

  const agent = new RemoteHookAgent({
    environmentId,
    connect: async () => {
      // Re-read the environment on every (re)connect so credential edits and
      // fresh Vault resolutions apply without restarting Tether.
      const envRow = getEnvironment(environmentId);
      if (!envRow || envRow.type !== 'ssh') {
        throw new Error('Environment no longer exists or is not SSH');
      }
      const raw = JSON.parse(envRow.config) as Record<string, unknown>;
      return connectSshControl(await resolveSshConfig(raw));
    },
    readHelperSource: () => fs.readFileSync(getHelperPath(), 'utf8'),
    bootId,
    // Forwarded frames feed the same sink the local bridge dispatches to —
    // one event path for local and remote sessions alike.
    onEvent: bridge.dispatchEvent,
    validate: bridge.validate,
    issueToken: (sessionId) => bridge.issueSessionToken(sessionId),
    revokeToken: (sessionId) => bridge.revokeSessionToken(sessionId),
    setSessionHookCapable: (sessionId, capable) => statusDetector.setHookCapable(sessionId, capable),
  });
  agents.set(environmentId, agent);
  return agent;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * Env vars for a remote session's CLI launch line — `{ TETHER_HOOK_ENV_FILE }`
 * when remote hooks apply and host setup succeeds within the timeout, `{}` in
 * every other case (session launches cadence-only; never throws). On timeout
 * the setup keeps running in the background so the *next* session on the env
 * gets hooks without paying the connect cost again — but THIS session's
 * abandoned attach is undone when it eventually lands, since its CLI launched
 * without the env-file pointer and must never be flipped hookCapable.
 */
export async function envForRemoteSession(
  sessionId: string,
  envRow: EnvironmentRow,
  cliTool: CliToolId,
): Promise<Record<string, string>> {
  const environmentId = envRow.id;
  try {
    if (getDb().config?.cliHooksEnabled !== 'true') return {};
    if (!getHookBridge()) return {};
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(envRow.config) as Record<string, unknown>;
    } catch {
      return {};
    }
    if (!remoteHooksEligible(envRow.type, config, cliTool)) return {};

    const agent = getOrCreateAgent(environmentId);
    const envPromise = agent.envForSession(sessionId, cliTool);
    try {
      return await withTimeout(
        envPromise,
        ENV_SETUP_TIMEOUT_MS,
        `Remote hook setup exceeded ${ENV_SETUP_TIMEOUT_MS}ms`,
      );
    } catch (err) {
      // Undo the phantom attach if the abandoned call completes later; when
      // it failed outright there is nothing attached and detach no-ops.
      envPromise
        .then(() => agent.detachSession(sessionId))
        .catch(() => { /* setup failed — nothing attached */ });
      throw err;
    }
  } catch (err) {
    if (!failureLogged.has(environmentId)) {
      failureLogged.add(environmentId);
      log.warn('Remote hooks unavailable for environment — sessions degrade to cadence-only detection', {
        environmentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return {};
  }
}

/**
 * Detach a torn-down session from its agent (refcount−−; the last session out
 * uninstalls the overlays and disconnects). Fire-and-forget safe: no-op for
 * sessions that never got remote hooks.
 */
export function detachRemoteSession(sessionId: string): void {
  for (const [environmentId, agent] of agents) {
    if (!agent.hasSession(sessionId)) continue;
    agent.detachSession(sessionId).then(
      () => {
        if (agent.currentState === 'disposed') agents.delete(environmentId);
      },
      (err) => {
        log.warn('Remote hook detach failed — next connect will scrub', {
          environmentId,
          error: err instanceof Error ? err.message : String(err),
        });
      },
    );
    return;
  }
}

/** True while any agent holds a live control connection (quit-cap decision). */
export function hasLiveRemoteAgents(): boolean {
  for (const agent of agents.values()) {
    if (agent.currentState === 'ready') return true;
  }
  return false;
}

/** Dispose every agent (app shutdown): scrub overlays, drop connections. */
export async function stopRemoteHookService(): Promise<void> {
  const all = Array.from(agents.values());
  agents.clear();
  await Promise.allSettled(all.map((agent) => agent.dispose()));
}
