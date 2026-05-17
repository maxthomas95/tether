import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '../db/atomic-write';
import { getClaudeHome } from '../claude/transcripts';
import { createLogger } from '../logger';
import { quoteShellArg } from '../../shared/shell-quote';
import { SENTINEL_TOKEN, createOverlayMutex } from './overlay-common';

const log = createLogger('claude-overlay');

/**
 * Additively merge Tether-managed `Notification` and `Stop` hook entries
 * into the user's `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR`).
 *
 * Lifetime model (option A′):
 *   - install on Tether launch
 *   - uninstall on Tether clean shutdown
 *   - scrub orphans at install time so a crash-recovered launch is clean
 *
 * Sentinel: any hook entry whose `command` substring contains
 * `SENTINEL_TOKEN` is treated as Tether-managed and removed on scrub. The
 * token appears in the helper path (`…/tether-cli-hook/index.js`) so the
 * sentinel matches without us needing to inject a separate marker.
 *
 * Concurrency: every public function in this module routes through
 * `withMutex` so two concurrent calls inside the same Tether process
 * can't interleave their read-modify-write cycles.
 */

export interface ClaudeOverlayContext {
  /** Absolute path to `cli-tools/tether-cli-hook/index.js`. */
  helperPath: string;
  /** Override target file (tests only). Defaults to `<claude-home>/settings.json`. */
  settingsPath?: string;
}

const withMutex = createOverlayMutex();

interface CommandHook { type?: string; command?: string; [k: string]: unknown }
interface NotificationGroup { matcher?: string; hooks?: CommandHook[]; [k: string]: unknown }
interface StopEntryGroup { hooks?: CommandHook[]; [k: string]: unknown }
type StopEntry = CommandHook | StopEntryGroup;
interface SettingsShape {
  hooks?: {
    Notification?: NotificationGroup[];
    Stop?: StopEntry[];
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

function resolveSettingsPath(ctx: ClaudeOverlayContext): string {
  return ctx.settingsPath || path.join(getClaudeHome(), 'settings.json');
}

function readSettings(filePath: string): SettingsShape {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as SettingsShape;
    }
    log.warn('settings.json is not an object; treating as empty', { filePath });
    return {};
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return {};
    log.warn('settings.json read/parse failed; treating as empty', {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    // Bail rather than mangle: throw so the caller can decide. The IPC
    // boundary above us turns this into a user-visible toast — better than
    // silently overwriting a malformed-but-recoverable file.
    throw new Error(`Unable to parse ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function isTetherManaged(hook: CommandHook | undefined): boolean {
  return typeof hook?.command === 'string' && hook.command.includes(SENTINEL_TOKEN);
}

/**
 * Strip every Tether-managed entry from the Notification and Stop arrays.
 * Returns true if the structure changed (used to decide whether to write).
 */
function scrubTetherEntries(settings: SettingsShape): boolean {
  if (!settings.hooks || typeof settings.hooks !== 'object') return false;
  let changed = false;

  const notif = settings.hooks.Notification;
  if (Array.isArray(notif)) {
    const filtered: NotificationGroup[] = [];
    for (const group of notif) {
      if (!group || typeof group !== 'object') continue;
      const hooksArr = Array.isArray(group.hooks) ? group.hooks.filter((h) => !isTetherManaged(h)) : group.hooks;
      // Drop groups that become empty after scrub — keeps the file tidy.
      if (Array.isArray(hooksArr) && hooksArr.length === 0) {
        changed = true;
        continue;
      }
      if (Array.isArray(group.hooks) && Array.isArray(hooksArr) && hooksArr.length !== group.hooks.length) {
        changed = true;
        filtered.push({ ...group, hooks: hooksArr });
      } else {
        filtered.push(group);
      }
    }
    if (filtered.length === 0) {
      delete settings.hooks.Notification;
      changed = true;
    } else {
      settings.hooks.Notification = filtered;
    }
  }

  const stop = settings.hooks.Stop;
  if (Array.isArray(stop)) {
    const filtered: StopEntry[] = [];
    for (const entry of stop) {
      if (!entry || typeof entry !== 'object') continue;
      // Stop entries can be either bare {type,command} hooks or grouped
      // {hooks:[...]} — handle both shapes.
      if ('command' in entry || 'type' in entry) {
        if (!isTetherManaged(entry as CommandHook)) filtered.push(entry);
        else changed = true;
      } else if (Array.isArray((entry as StopEntryGroup).hooks)) {
        const group = entry as StopEntryGroup;
        const hooksArr = (group.hooks || []).filter((h) => !isTetherManaged(h));
        if (hooksArr.length === 0) { changed = true; continue; }
        if (hooksArr.length !== (group.hooks || []).length) {
          changed = true;
          filtered.push({ ...group, hooks: hooksArr });
        } else {
          filtered.push(group);
        }
      } else {
        filtered.push(entry);
      }
    }
    if (filtered.length === 0) {
      delete settings.hooks.Stop;
      changed = true;
    } else {
      settings.hooks.Stop = filtered;
    }
  }

  // Tidy up: drop `hooks` entirely if every sub-key is gone.
  if (settings.hooks && Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }
  return changed;
}

/**
 * Render the absolute path to the helper as a shell command string.
 * `helperPath` is internally derived, but it still crosses the user's login
 * shell when Claude runs the hook, so keep the quoting rules centralized.
 */
function helperCommand(helperPath: string, cliFlag: '--claude' | '--codex'): string {
  return `node ${quoteShellArg(helperPath)} ${cliFlag}`;
}

function buildTetherEntries(helperPath: string): {
  notification: NotificationGroup;
  stop: StopEntryGroup;
} {
  const cmd = helperCommand(helperPath, '--claude');
  // Both Notification and Stop entries take the same wrapper shape:
  // { matcher?: string; hooks: [{ type, command }] }. Stop doesn't accept
  // matchers but the runtime still requires the `hooks` array — bare
  // {type, command} entries fail validation with "Expected array, but
  // received undefined" even though the docs example shows the bare form.
  //
  // Notification matcher: docs claim omitting = "match all", but in practice
  // Claude appears to only fire entries whose matcher field is set. We list
  // every documented event type explicitly so the match is unambiguous and
  // future-Claude additions can be appended here as we want them.
  const NOTIFICATION_MATCHER = [
    'permission_prompt',
    'idle_prompt',
    'auth_success',
    'elicitation_dialog',
    'elicitation_complete',
    'elicitation_response',
  ].join('|');
  return {
    notification: { matcher: NOTIFICATION_MATCHER, hooks: [{ type: 'command', command: cmd }] },
    stop: { hooks: [{ type: 'command', command: cmd }] },
  };
}

/**
 * Install Tether's hook entries. Idempotent: scrubs any prior Tether-managed
 * entries first (whether from a clean uninstall path or a crashed earlier
 * run), then appends fresh ones.
 *
 * Throws if `settings.json` exists but is unparseable — caller should surface
 * to the user rather than overwrite mystery content.
 */
export async function installClaudeHooks(ctx: ClaudeOverlayContext): Promise<void> {
  await withMutex(async () => {
    const filePath = resolveSettingsPath(ctx);
    const settings = readSettings(filePath);
    scrubTetherEntries(settings);

    const entries = buildTetherEntries(ctx.helperPath);
    settings.hooks = settings.hooks || {};
    const notif = Array.isArray(settings.hooks.Notification) ? settings.hooks.Notification : [];
    notif.push(entries.notification);
    settings.hooks.Notification = notif;

    const stop = Array.isArray(settings.hooks.Stop) ? settings.hooks.Stop : [];
    stop.push(entries.stop);
    settings.hooks.Stop = stop;

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    atomicWriteFileSync(filePath, JSON.stringify(settings, null, 2) + '\n');
    log.info('Claude hooks installed', { filePath });
  });
}

/**
 * Remove every Tether-managed entry. No-op when settings.json is missing.
 * Idempotent and safe to call from a crash-recovered launch (scrubs the
 * orphans before the next install reinstalls fresh).
 */
export async function uninstallClaudeHooks(ctx: ClaudeOverlayContext): Promise<void> {
  await withMutex(async () => {
    const filePath = resolveSettingsPath(ctx);
    if (!fs.existsSync(filePath)) return;
    const settings = readSettings(filePath);
    const changed = scrubTetherEntries(settings);
    if (!changed) return;
    atomicWriteFileSync(filePath, JSON.stringify(settings, null, 2) + '\n');
    log.info('Claude hooks removed', { filePath });
  });
}
