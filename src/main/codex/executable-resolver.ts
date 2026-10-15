import { resolveCliExecutable, type ResolveCliExecutableOptions } from '../cli/executable-resolver';

// Preserve Codex's app-server defaults while sharing safe executable discovery
// with Claude Code and OpenCode metadata readers.
export { resolveWindowsSystemExecutable } from '../cli/executable-resolver';
export type { CliExecutableLaunch as CodexExecutableLaunch } from '../cli/executable-resolver';
export type ResolveCodexExecutableOptions = ResolveCliExecutableOptions;

export function resolveCodexExecutable(opts: ResolveCodexExecutableOptions = {}) {
  return resolveCliExecutable('codex', { ...opts, args: opts.args ?? ['app-server'] });
}
