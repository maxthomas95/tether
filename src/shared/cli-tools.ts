export type CliToolId = 'claude' | 'codex' | 'opencode' | 'custom';

export interface CliToolDef {
  id: CliToolId;
  displayName: string;
  binaryName: string;
  supportsSessionResume: boolean;
  commonFlags: Array<{ flag: string; label: string }>;
}

export const CLI_TOOL_REGISTRY: Record<CliToolId, CliToolDef> = {
  claude: {
    id: 'claude',
    displayName: 'Claude Code',
    binaryName: 'claude',
    supportsSessionResume: true,
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
    supportsSessionResume: false,
    commonFlags: [
      { flag: '--quiet', label: 'Quiet mode' },
      { flag: '--full-auto', label: 'Full auto mode' },
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
