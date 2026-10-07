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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Claude writes no transcript until the first message, and /resume or /clear
// moves the pane to another id, so a saved id can have no history. A bare
// --resume then dead-ends the pane; --session-id keeps the same id instead.
const CLAUDE_TRANSCRIPT_CHECK =
  'for f in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/"$1".jsonl; do [ -f "$f" ] && exit 0; done; exit 1';

function claudeResumeFlag(id: string, env: Record<string, string> = {}): string {
  const scopedEnv = buildEnvAssignments({ HOME: env.HOME, CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR });
  const check = [
    ...(scopedEnv.length > 0 ? ['env', ...scopedEnv] : []),
    'sh', '-c', quotePosixShellArg(CLAUDE_TRANSCRIPT_CHECK), 'tether-resume-check', quotePosixShellArg(id),
  ].join(' ');
  return `"$(${check} && printf %s --resume || printf %s --session-id)"`;
}

export function buildRemoteCliCommand(options: {
  command?: { file: string; args: string[] };
  binaryName?: string;
  cliTool?: CliToolId;
  cliArgs?: string[];
  env?: Record<string, string>;
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
  const words = argv.map(quotePosixShellArg);
  const resumeFlagAt = argv.length - 2;
  if ((options.cliTool || 'claude') === 'claude' && resumeToolSessionId && UUID_RE.test(resumeToolSessionId)
    && argv[resumeFlagAt] === '--resume' && argv[resumeFlagAt + 1] === resumeToolSessionId) {
    words[resumeFlagAt] = claudeResumeFlag(resumeToolSessionId, options.env);
  }
  if (options.initialPrompt) {
    words.push(quotePosixShellArg(options.initialPrompt));
  }
  return words.join(' ');
}
