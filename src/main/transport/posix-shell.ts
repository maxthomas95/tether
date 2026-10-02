import type { CliToolId } from '../../shared/types';
import { buildCliArgsForTool } from '../../shared/cli-tools';
import {
  quotePosixEnvAssignment,
  quotePosixPathPreservingHome,
  quotePosixShellArg,
} from '../../shared/shell-quote';
import { tokenizeCliArgEntries } from './cli-args';

export { quotePosixShellArg };

// Preserve a leading ~ so the remote login shell can expand it.
export function quoteRemotePath(value: string): string {
  return quotePosixPathPreservingHome(value);
}

export function buildEnvAssignments(env: Record<string, string> = {}): string[] {
  return Object.entries(env)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '')
    .map(([name, value]) => quotePosixEnvAssignment(name, value));
}

export function buildRemoteCliCommand(options: {
  command?: { file: string; args: string[] };
  binaryName?: string;
  cliTool?: CliToolId;
  cliArgs?: string[];
  initialPrompt?: string;
  toolSessionId?: string | null;
  resumeToolSessionId?: string | null;
  claudeSessionId?: string | null;
  resumeClaudeSessionId?: string | null;
}): string {
  if (options.command) {
    return [options.command.file, ...options.command.args].map(quotePosixShellArg).join(' ');
  }
  const resumeToolSessionId = options.resumeToolSessionId || options.resumeClaudeSessionId;
  const toolSessionId = options.toolSessionId || options.claudeSessionId;
  const toolArgs = buildCliArgsForTool(options.cliTool || 'claude', options.cliArgs || [], {
    resumeToolSessionId,
    toolSessionId,
  });
  const argv = [
    options.binaryName || 'claude',
    ...tokenizeCliArgEntries(toolArgs),
  ];
  if (options.initialPrompt) {
    argv.push(options.initialPrompt);
  }
  return argv.map(quotePosixShellArg).join(' ');
}
