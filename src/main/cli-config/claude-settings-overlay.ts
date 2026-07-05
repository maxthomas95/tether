import path from 'node:path';
import { getClaudeHome } from '../claude/transcripts';
import { createLogger } from '../logger';
import { quoteShellArg, type ShellPlatform } from '../../shared/shell-quote';
import {
  SENTINEL_TOKEN,
  createOverlayMutex,
  localConfigFileStore,
  type ConfigFileStore,
} from './overlay-common';

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
  /**
   * Filesystem seam. Defaults to the local fs + atomic-write store; remote
   * transports (and tests) inject their own. Pure merge/scrub logic is
   * exported separately and takes no store.
   */
  store?: ConfigFileStore;
  /**
   * Shell platform used to quote the helper path in the hook command.
   * Defaults to the current platform (unchanged behavior). Lets a remote
   * (e.g. POSIX) install quote correctly from a Windows host.
   */
  platform?: ShellPlatform;
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

/**
 * Parse settings text into the working shape. A non-object top-level value is
 * treated as empty (warned). Unparseable text THROWS — the caller must never
 * overwrite mystery content. `null` text (missing file) yields `{}`.
 *
 * `label` only flavors the thrown error / log line (file path in practice).
 */
function parseSettings(text: string | null, label: string): SettingsShape {
  if (text === null) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as SettingsShape;
    }
    log.warn('settings.json is not an object; treating as empty', { label });
    return {};
  } catch (err) {
    // Bail rather than mangle: throw so the caller can decide. The IPC
    // boundary above us turns this into a user-visible toast — better than
    // silently overwriting a malformed-but-recoverable file.
    throw new Error(`Unable to parse ${label}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Serialize a settings object back to the on-disk text form (2-space, trailing newline). */
function serializeSettings(settings: SettingsShape): string {
  return JSON.stringify(settings, null, 2) + '\n';
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
 *
 * `platform` selects the quoting rules — defaults to the current platform so
 * local behavior is unchanged; a remote POSIX install passes `'posix'`.
 */
export function helperCommand(
  helperPath: string,
  cliFlag: '--claude' | '--codex',
  platform?: ShellPlatform,
): string {
  return `node ${quoteShellArg(helperPath, platform)} ${cliFlag}`;
}

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

/**
 * Pure: additively merge Tether's hook entries into `text` (the current
 * settings.json content, or null/empty for a missing file) and return the
 * rewritten text. Scrubs prior Tether-managed entries first (idempotent /
 * crash-recovery), then appends fresh Notification + Stop entries.
 *
 * THROWS if `text` is present but unparseable — never returns mangled output.
 * No I/O — drive it through a ConfigFileStore at the call site.
 *
 * @param helperCmd Pre-rendered hook command (`node <helper> --claude`).
 */
export function mergeClaudeSettings(text: string | null, helperCmd: string): string {
  const settings = parseSettings(text, 'settings.json');
  scrubTetherEntries(settings);

  settings.hooks = settings.hooks || {};
  const notif = Array.isArray(settings.hooks.Notification) ? settings.hooks.Notification : [];
  notif.push({ matcher: NOTIFICATION_MATCHER, hooks: [{ type: 'command', command: helperCmd }] });
  settings.hooks.Notification = notif;

  const stop = Array.isArray(settings.hooks.Stop) ? settings.hooks.Stop : [];
  stop.push({ hooks: [{ type: 'command', command: helperCmd }] });
  settings.hooks.Stop = stop;

  return serializeSettings(settings);
}

/**
 * Pure: strip every Tether-managed hook entry from `text`. Returns the
 * rewritten text and whether anything changed (callers skip the write when
 * unchanged). THROWS on unparseable input. `null` text → `{ changed: false }`.
 */
export function scrubClaudeSettings(text: string | null): { text: string; changed: boolean } {
  if (text === null) return { text: '', changed: false };
  const settings = parseSettings(text, 'settings.json');
  const changed = scrubTetherEntries(settings);
  return { text: serializeSettings(settings), changed };
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
    const store = ctx.store ?? localConfigFileStore;
    const filePath = resolveSettingsPath(ctx);
    const helperCmd = helperCommand(ctx.helperPath, '--claude', ctx.platform);
    const merged = mergeClaudeSettings(store.read(filePath), helperCmd);
    store.writeAtomic(filePath, merged);
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
    const store = ctx.store ?? localConfigFileStore;
    const filePath = resolveSettingsPath(ctx);
    if (!store.exists(filePath)) return;
    const { text, changed } = scrubClaudeSettings(store.read(filePath));
    if (!changed) return;
    store.writeAtomic(filePath, text);
    log.info('Claude hooks removed', { filePath });
  });
}
