import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '../db/atomic-write';
import { getCodexHome } from '../codex/transcripts';
import { createLogger } from '../logger';
import { SENTINEL_TOKEN, createOverlayMutex } from './overlay-common';

const log = createLogger('codex-overlay');

/**
 * Additively merge a Tether-managed `notify` entry into the user's
 * `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`).
 *
 * Codex's `notify` config is a single top-level key whose value is a string
 * array — the program + argv prefix Codex invokes when it has something to
 * report. Codex appends the JSON payload as the final argv element, so
 * setting:
 *
 *   notify = ["node", "/abs/path/tether-cli-hook/index.js", "--codex"]
 *
 * makes Codex run `node /abs/path/.../index.js --codex '<json>'` — which is
 * exactly what the helper's `--codex` branch expects (it reads payload from
 * `process.argv[3]`).
 *
 * Lifetime model mirrors the Claude overlay (option A′):
 *   - install on Tether launch
 *   - uninstall on Tether clean shutdown
 *   - scrub orphans at install time so a crash-recovered launch is clean
 *
 * Sentinel: any `notify` array whose contents include the substring
 * `tether-cli-hook` is treated as Tether-managed. The token appears in the
 * helper path (`…/tether-cli-hook/index.js`) so we don't need a separate
 * marker.
 *
 * TOML handling: we do NOT pull in a TOML library. The surface we touch is
 * a single top-level `notify = [...]` assignment, which we can locate and
 * replace textually while leaving every other line — including comments and
 * unrelated sections — completely untouched. The merge logic is:
 *
 *   1. Read the file as text (treat missing file as empty).
 *   2. Walk the lines, tracking whether we're inside a `[section]` header.
 *   3. Find any top-level `notify =` assignment (handles multi-line arrays).
 *   4. If it's Tether-managed (sentinel match) — strip it.
 *      If it's user-owned — leave it; we don't trample user notify configs.
 *   5. Append our fresh `notify = [...]` line at the end of the top-level
 *      pre-section block (after any existing top-level keys, before the
 *      first `[section]`).
 *
 * Concurrency: every public function routes through `withMutex` to avoid
 * interleaved read-modify-writes inside a single Tether process.
 */

export interface CodexOverlayContext {
  /** Absolute path to `cli-tools/tether-cli-hook/index.js`. */
  helperPath: string;
  /** Override target file (tests only). Defaults to `<codex-home>/config.toml`. */
  configPath?: string;
}

const withMutex = createOverlayMutex();

function resolveConfigPath(ctx: CodexOverlayContext): string {
  return ctx.configPath || path.join(getCodexHome(), 'config.toml');
}

function readFileOrEmpty(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return '';
    log.warn('config.toml read failed; treating as empty', {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return '';
  }
}

/** True if the line is a `[header]` or `[[array.header]]` start. */
function isSectionHeader(line: string): boolean {
  const t = line.trim();
  if (!t.startsWith('[')) return false;
  // Strip trailing comment so `[foo] # comment` still counts. Use indexOf
  // rather than a regex to sidestep Sonar S5852 (super-linear backtracking).
  const hash = t.indexOf('#');
  const noComment = (hash === -1 ? t : t.slice(0, hash)).trim();
  return /^\[\[?[^\]]+\]\]?$/.test(noComment);
}

interface NotifyRange {
  /** Inclusive start line index of the `notify = ...` assignment. */
  start: number;
  /** Inclusive end line index (handles multi-line arrays). */
  end: number;
  /** Full assignment text (joined lines) for sentinel detection. */
  text: string;
}

/**
 * Find every top-level (outside any `[section]`) `notify = ...` assignment.
 * Returns them in line order. Multi-line array values are kept together.
 */
function findTopLevelNotifyRanges(lines: string[]): NotifyRange[] {
  const out: NotifyRange[] = [];
  let inSection = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isSectionHeader(line)) {
      inSection = true;
      i++;
      continue;
    }
    if (!inSection && /^\s*notify\s*=/.test(line)) {
      // Walk forward until brackets balance (or until end of file).
      let depth = 0;
      let sawOpen = false;
      let j = i;
      let joined = '';
      while (j < lines.length) {
        const l = lines[j];
        joined += (j === i ? '' : '\n') + l;
        for (const ch of l) {
          if (ch === '[') { depth++; sawOpen = true; }
          else if (ch === ']') { depth--; }
        }
        if (sawOpen && depth <= 0) break;
        // Non-array (e.g. `notify = "foo"`) — single line.
        if (!sawOpen && j === i) break;
        j++;
      }
      out.push({ start: i, end: j, text: joined });
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
}

function isTetherManaged(notifyText: string): boolean {
  return notifyText.includes(SENTINEL_TOKEN);
}

/**
 * Remove every Tether-managed `notify` assignment from `lines`. Returns
 * `{ lines, changed }` so callers can decide whether to rewrite the file.
 */
function scrubTetherNotify(lines: string[]): { lines: string[]; changed: boolean } {
  const ranges = findTopLevelNotifyRanges(lines);
  const toDelete = ranges.filter((r) => isTetherManaged(r.text));
  if (toDelete.length === 0) return { lines, changed: false };

  // Build a set of line indices to remove.
  const drop = new Set<number>();
  for (const r of toDelete) {
    for (let k = r.start; k <= r.end; k++) drop.add(k);
  }
  // Also collapse a trailing blank line if removing left a double-blank,
  // but only when the removed range was followed by a blank — keep the diff
  // minimal in the common case.
  const kept = lines.filter((_, idx) => !drop.has(idx));
  return { lines: kept, changed: true };
}

/**
 * Serialize a string array as a single-line TOML array literal. Codex's
 * notify program/argv values are paths and flags — no embedded newlines —
 * so we don't bother with multi-line formatting. Escapes backslashes and
 * double-quotes per TOML basic-string rules.
 */
function tomlStringArray(values: string[]): string {
  const escaped = values.map((v) => {
    const s = v
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
    return `"${s}"`;
  });
  return `[${escaped.join(', ')}]`;
}

function buildNotifyLine(helperPath: string): string {
  // Argv layout the helper expects in --codex mode:
  //   node <helperPath> --codex '<json>'
  // Codex auto-appends the JSON payload as the final argv element, so we
  // only need to provide the prefix.
  return `notify = ${tomlStringArray(['node', helperPath, '--codex'])}`;
}

/**
 * Insert `notifyLine` at the end of the top-level (pre-section) block.
 * Keeps a single blank line of separation if there's already preceding
 * content.
 */
function appendNotifyToTopLevel(lines: string[], notifyLine: string): string[] {
  let insertIdx = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (isSectionHeader(lines[i])) { insertIdx = i; break; }
  }
  const before = lines.slice(0, insertIdx);
  const after = lines.slice(insertIdx);

  // Trim trailing blank lines off `before` so we control spacing.
  while (before.length > 0 && before[before.length - 1].trim() === '') {
    before.pop();
  }

  const out = [...before];
  if (out.length > 0) out.push('');
  out.push(notifyLine);
  if (after.length > 0) out.push('');
  return [...out, ...after];
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  // Preserve trailing newline behaviour by stripping it before split — we
  // re-add when rejoining if the source had one.
  return text.split(/\r?\n/);
}

function joinLines(lines: string[], hadTrailingNewline: boolean): string {
  const joined = lines.join('\n');
  return hadTrailingNewline || joined.length > 0 ? joined + '\n' : joined;
}

/**
 * Install Tether's notify entry. Idempotent: scrubs any prior Tether-managed
 * notify line first (whether from a clean uninstall path or a crashed prior
 * run), then appends a fresh one. Leaves a user-owned `notify` line alone —
 * we never silently displace their configuration.
 */
export async function installCodexHooks(ctx: CodexOverlayContext): Promise<void> {
  await withMutex(async () => {
    const filePath = resolveConfigPath(ctx);
    const original = readFileOrEmpty(filePath);
    const hadTrailingNewline = original.endsWith('\n');
    let lines = splitLines(original.endsWith('\n') ? original.slice(0, -1) : original);

    const scrub = scrubTetherNotify(lines);
    lines = scrub.lines;

    // If a non-Tether top-level `notify` survives the scrub, the user is
    // already wired to something. Don't fight them: bail without touching
    // the file (but still write if we removed orphans).
    const remaining = findTopLevelNotifyRanges(lines);
    if (remaining.length > 0) {
      log.warn('Skipping Codex notify install — user-owned notify entry present', { filePath });
      if (scrub.changed) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        atomicWriteFileSync(filePath, joinLines(lines, hadTrailingNewline || lines.length > 0));
      }
      return;
    }

    lines = appendNotifyToTopLevel(lines, buildNotifyLine(ctx.helperPath));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    atomicWriteFileSync(filePath, joinLines(lines, true));
    log.info('Codex notify installed', { filePath });
  });
}

/**
 * Remove every Tether-managed notify entry. No-op when config.toml is
 * missing or contains no Tether entries. Idempotent and safe to call from a
 * crash-recovered launch.
 */
export async function uninstallCodexHooks(ctx: CodexOverlayContext): Promise<void> {
  await withMutex(async () => {
    const filePath = resolveConfigPath(ctx);
    if (!fs.existsSync(filePath)) return;
    const original = readFileOrEmpty(filePath);
    const hadTrailingNewline = original.endsWith('\n');
    const lines = splitLines(original.endsWith('\n') ? original.slice(0, -1) : original);

    const scrub = scrubTetherNotify(lines);
    if (!scrub.changed) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    atomicWriteFileSync(filePath, joinLines(scrub.lines, hadTrailingNewline || scrub.lines.length > 0));
    log.info('Codex notify removed', { filePath });
  });
}
