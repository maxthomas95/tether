export type CliToolId = 'claude' | 'codex' | 'opencode' | 'custom';

export interface CliToolDef {
  id: CliToolId;
  displayName: string;
  binaryName: string;
  supportsSessionResume: boolean;
  historyProvider?: 'claude' | 'codex';
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
      { flag: '--verbose', label: 'Verbose output' },
      { flag: '--no-telemetry', label: 'Disable telemetry' },
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
  opencode: {
    id: 'opencode',
    displayName: 'OpenCode',
    binaryName: 'opencode',
    supportsSessionResume: false,
    commonFlags: [],
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

  return [...cliArgs];
}
