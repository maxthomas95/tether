import type { CliToolId } from '../../shared/types';

const DANGEROUS_SKIP_FLAG = '--dangerously-skip-permissions';

/**
 * True when any CLI-arg entry is — or, for whitespace-packed entries like
 * "--dangerously-skip-permissions --verbose", contains — the skip-permissions
 * flag. Mirrors the whitespace tokenization the transports apply at launch, so
 * a single-string entry with the flag embedded is still detected.
 */
export function hasDangerousSkipPermissions(cliArgs: string[] = []): boolean {
  return cliArgs.some(entry => entry.trim().split(/\s+/).includes(DANGEROUS_SKIP_FLAG));
}

/**
 * Claude Code refuses to launch with `--dangerously-skip-permissions` when it
 * detects it is running as root (uid 0) on POSIX, exiting immediately with:
 *   "--dangerously-skip-permissions cannot be used with root/sudo privileges
 *    for security reasons"
 * unless it believes it is inside a sandbox. It treats `IS_SANDBOX=1` (and
 * `CLAUDE_CODE_BUBBLEWRAP=1`) as that signal. The guard never fires on Windows
 * (no `getuid`), which is why the same flag works on a local Windows session
 * but bounces the user straight back to the shell over SSH-as-root.
 *
 * When Tether *knowingly* launches Claude as root — an SSH environment with
 * sudo elevation, a root SSH login, or (post-Windows) a local root user — the
 * user has already opted into skipping permissions by passing the flag, so we
 * honor that intent by setting `IS_SANDBOX=1` rather than letting the CLI abort.
 * Only Claude has this guard; every other CLI is left untouched.
 *
 * Returns a new env object; never mutates the input. A user-provided
 * `IS_SANDBOX` / `CLAUDE_CODE_BUBBLEWRAP` is left exactly as-is so explicit
 * config always wins over this inference.
 */
export function withRootSandboxBypass(
  env: Record<string, string>,
  options: { cliTool?: CliToolId; cliArgs?: string[] },
  runsAsRoot: boolean,
): Record<string, string> {
  if (!runsAsRoot) return env;
  if ((options.cliTool || 'claude') !== 'claude') return env;
  if (!hasDangerousSkipPermissions(options.cliArgs)) return env;
  if ('IS_SANDBOX' in env || 'CLAUDE_CODE_BUBBLEWRAP' in env) return env;
  return { ...env, IS_SANDBOX: '1' };
}
