export type CliToolId = 'claude' | 'codex' | 'copilot' | 'opencode' | 'custom';

export interface CliToolDef {
  id: CliToolId;
  displayName: string;
  binaryName: string;
  supportsSessionResume: boolean;
  historyProvider?: 'claude' | 'codex' | 'copilot' | 'opencode';
  commonFlags: Array<{ flag: string; label: string }>;
}

export const CLI_TOOL_REGISTRY: Record<CliToolId, CliToolDef> = {
  claude: {
    id: 'claude',
    displayName: 'Claude Code',
    binaryName: 'claude',
    supportsSessionResume: true,
    historyProvider: 'claude',
    commonFlags: [
      { flag: '--dangerously-skip-permissions', label: 'Skip permission prompts' },
      { flag: '--permission-mode plan', label: 'Plan mode (no edits)' },
      { flag: '--bare', label: 'Minimal mode (skip hooks/plugins)' },
      { flag: '--verbose', label: 'Verbose output' },
    ],
  },
  codex: {
    id: 'codex',
    displayName: 'Codex CLI',
    binaryName: 'codex',
    supportsSessionResume: true,
    historyProvider: 'codex',
    commonFlags: [
      { flag: '--full-auto', label: 'Full auto mode' },
      { flag: '--search', label: 'Enable web search' },
      { flag: '--no-alt-screen', label: 'Disable alternate screen' },
      {
        flag: '--dangerously-bypass-approvals-and-sandbox',
        label: 'Bypass approvals and sandbox',
      },
    ],
  },
  copilot: {
    id: 'copilot',
    displayName: 'GitHub Copilot CLI',
    binaryName: 'copilot',
    supportsSessionResume: true,
    historyProvider: 'copilot',
    commonFlags: [
      { flag: '--yolo', label: 'Allow all tools, paths, and URLs' },
      { flag: '--plan', label: 'Plan mode (no execution)' },
      { flag: '--autopilot', label: 'Autopilot continuation' },
      { flag: '--allow-all-tools', label: 'Allow all tools without prompting' },
      { flag: '--no-banner', label: 'Hide startup banner' },
    ],
  },
  opencode: {
    id: 'opencode',
    displayName: 'OpenCode',
    binaryName: 'opencode',
    supportsSessionResume: true,
    historyProvider: 'opencode',
    commonFlags: [
      { flag: '--continue', label: 'Continue last session' },
      { flag: '--pure', label: 'Run without external plugins' },
      { flag: '--print-logs', label: 'Print logs to stderr' },
    ],
  },
  custom: {
    id: 'custom',
    displayName: 'Custom',
    binaryName: '',
    supportsSessionResume: false,
    commonFlags: [],
  },
};

export function getCliBinary(cliTool: CliToolId, config: Record<string, unknown> = {}): string {
  if (cliTool === 'custom') {
    return (typeof config.cliBinary === 'string' && config.cliBinary.trim()) || 'claude';
  }
  return CLI_TOOL_REGISTRY[cliTool].binaryName;
}

export function toolSupportsResume(cliTool: CliToolId): boolean {
  return CLI_TOOL_REGISTRY[cliTool]?.supportsSessionResume ?? false;
}

export function getToolHistoryProvider(cliTool: CliToolId): CliToolDef['historyProvider'] {
  return CLI_TOOL_REGISTRY[cliTool]?.historyProvider;
}

export function toolSupportsHistory(cliTool: CliToolId): boolean {
  return Boolean(getToolHistoryProvider(cliTool));
}

export function buildCliArgsForTool(
  cliTool: CliToolId,
  cliArgs: string[] = [],
  options: {
    toolSessionId?: string | null;
    resumeToolSessionId?: string | null;
  } = {},
): string[] {
  if (cliTool === 'claude') {
    const args = [...cliArgs];
    if (options.resumeToolSessionId) {
      args.push('--resume', options.resumeToolSessionId);
    } else if (options.toolSessionId) {
      args.push('--session-id', options.toolSessionId);
    }
    return args;
  }

  if (cliTool === 'codex' && options.resumeToolSessionId) {
    return ['resume', options.resumeToolSessionId, ...cliArgs];
  }

  if (cliTool === 'copilot' && options.resumeToolSessionId) {
    return ['--resume', options.resumeToolSessionId, ...cliArgs];
  }

  // OpenCode uses --session <id> (not --resume) to attach the TUI to an
  // existing conversation. See `opencode --help`.
  if (cliTool === 'opencode' && options.resumeToolSessionId) {
    return ['--session', options.resumeToolSessionId, ...cliArgs];
  }

  return [...cliArgs];
}
