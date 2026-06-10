import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { createHookBridge, type HookBridgeHandle } from './hook-bridge';
import { installClaudeHooks, uninstallClaudeHooks } from './claude-settings-overlay';
import { installCodexHooks, uninstallCodexHooks } from './codex-config-overlay';
import { sessionManager } from '../session/session-manager';
import { getDb } from '../db/database';
import { createLogger } from '../logger';

const log = createLogger('hook-service');

/**
 * Coordinator for the CLI-hook integration's lifetime. Owns the bridge
 * socket and the settings-file overlays; brokers per-session env vars.
 *
 * Lifecycle model A′:
 *   - `start()` at app `ready`: boot bridge → scrub-and-install overlays.
 *   - `stop()` at `before-quit`: uninstall overlays → dispose bridge.
 *   - Crash recovery: install-at-boot's scrub clears any prior-run orphans
 *     before laying fresh entries down. Net effect of a crashed shutdown
 *     is a one-launch delay before overlays are clean.
 *
 * Honors the `cliHooksEnabled` config bit (defaults to false; opt-in via
 * Settings or the Setup Wizard). When unset, hooks are not installed. When
 * disabled, `start()` still runs the orphan-scrub pass (defense in depth —
 * a user who toggles the feature off should not be left with our entries
 * on disk) but does not lay fresh ones, and `envForSession()` returns an
 * empty record so spawned CLIs run without `TETHER_HOOK_*` in env. The
 * helper already exits 0 when those vars are missing, so unwired sessions
 * degrade to byte-level detection without errors.
 */

let bridge: HookBridgeHandle | null = null;
let installed = false;

function helperPath(): string {
  // Packaged: shipped under <resources>/tether-cli-hook/ via Forge's
  // extraResource list. Dev: read from repo at cli-tools/tether-cli-hook/.
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'tether-cli-hook', 'index.js');
  }
  // __dirname during dev is `.vite/build/`. Climb to repo root.
  return path.resolve(__dirname, '..', '..', 'cli-tools', 'tether-cli-hook', 'index.js');
}

function isEnabled(): boolean {
  // Default-off, opt-in: user must explicitly enable via Settings or Setup Wizard.
  return getDb().config?.cliHooksEnabled === 'true';
}

export async function startHookService(): Promise<void> {
  const helper = helperPath();
  if (!fs.existsSync(helper)) {
    log.warn('Hook helper not found — CLI hooks disabled this session', { helper });
    return;
  }

  // Always run the orphan-scrub even if the feature is off; it's a no-op
  // for files that don't contain our sentinel and clears the previous
  // run's entries if the user just toggled the feature off.
  try {
    await uninstallClaudeHooks({ helperPath: helper });
  } catch (err) {
    log.warn('Boot-time Claude orphan scrub failed', { error: err instanceof Error ? err.message : String(err) });
  }
  try {
    await uninstallCodexHooks({ helperPath: helper });
  } catch (err) {
    log.warn('Boot-time Codex orphan scrub failed', { error: err instanceof Error ? err.message : String(err) });
  }

  if (!isEnabled()) {
    log.info('CLI hooks disabled by user setting — skipping bridge + install');
    return;
  }

  try {
    bridge = await createHookBridge((event) => {
      sessionManager.handleHookEvent(event.tetherSessionId, event.type);
    });
  } catch (err) {
    log.warn('Hook bridge failed to start — falling back to byte-level only', {
      error: err instanceof Error ? err.message : String(err),
    });
    bridge = null;
    return;
  }

  let anyInstalled = false;
  try {
    await installClaudeHooks({ helperPath: helper });
    anyInstalled = true;
  } catch (err) {
    log.warn('Claude hook install failed — leaving bridge running for any pre-installed entries', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    await installCodexHooks({ helperPath: helper });
    anyInstalled = true;
  } catch (err) {
    log.warn('Codex notify install failed — leaving bridge running for any pre-installed entries', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  installed = anyInstalled;
}

export async function stopHookService(): Promise<void> {
  if (installed) {
    const helper = helperPath();
    try {
      await uninstallClaudeHooks({ helperPath: helper });
    } catch (err) {
      log.warn('Claude hook uninstall failed during shutdown', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      await uninstallCodexHooks({ helperPath: helper });
    } catch (err) {
      log.warn('Codex notify uninstall failed during shutdown', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    installed = false;
  }
  if (bridge) {
    try { await bridge.dispose(); }
    catch (err) { log.warn('Bridge dispose failed', { error: err instanceof Error ? err.message : String(err) }); }
    bridge = null;
  }
}

/**
 * Build the per-session env subset that lets the helper find the bridge
 * and tag its event with the right Tether session id. Returns `{}` if
 * the bridge isn't running (either disabled or boot failed) so the env
 * spread on the caller side is a no-op.
 *
 * In dev mode (or whenever TETHER_DEBUG_HOOKS=1 is set in Tether's own
 * env) we also wire TETHER_HOOK_LOG_PATH so the helper appends an
 * invocation trace to a file. Helps diagnose "the hook never fires" /
 * "the helper silently degrades" without any user-visible change.
 */
export function envForSession(tetherSessionId: string): Record<string, string> {
  if (!bridge) return {};
  const env: Record<string, string> = {
    TETHER_HOOK_SOCKET: bridge.socketPath,
    TETHER_HOOK_TOKEN: bridge.token,
    TETHER_SESSION_ID: tetherSessionId,
  };
  if (!app.isPackaged || process.env.TETHER_DEBUG_HOOKS === '1') {
    env.TETHER_HOOK_LOG_PATH = path.join(app.getPath('userData'), 'logs', 'hook-helper.log');
  }
  return env;
}

/**
 * Revoke any per-session hook token for a torn-down session. Harmless today
 * (local sessions all share the boot-global token, which this never touches),
 * but required once remote sessions get per-session scoped tokens — a revoked
 * token must stop authorizing forwarded hook frames immediately. No-op when
 * the bridge isn't running.
 */
export function revokeSessionToken(tetherSessionId: string): void {
  bridge?.revokeSessionToken(tetherSessionId);
}

/**
 * For tests and Settings UI: report whether the bridge is currently
 * accepting events. Doesn't reflect overlay-install status — that can be
 * false even when the bridge is up (e.g. if settings.json failed to
 * parse).
 */
export function isHookServiceActive(): boolean {
  return bridge !== null;
}
