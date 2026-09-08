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

export type CodexReasoningEffort = 'low' | 'medium' | 'high';

export interface CodexLaunchSelection {
  model?: string;
  profile?: string;
  reasoningEffort?: CodexReasoningEffort | '';
}

export interface CodexLaunchFlagsUpdate {
  flags: string[];
  conflict: string | null;
}

const CODEX_SAFE_VALUE_RE = /^[A-Za-z0-9._:@/+~-]+$/;
const CODEX_REASONING_EFFORTS = new Set<CodexReasoningEffort>(['low', 'medium', 'high']);

export function isSafeCodexLaunchValue(value: string): boolean {
  return CODEX_SAFE_VALUE_RE.test(value);
}

function codexConfigKey(entry: string): string | null {
  const trimmed = entry.trim();
  const match = /^(?:-c|--config)(?:\s+|=)([^=\s]+)=/.exec(trimmed);
  return match?.[1] ?? null;
}

function isCodexModelFlag(entry: string): boolean {
  const trimmed = entry.trim();
  return trimmed === '--model'
    || trimmed === '-m'
    || trimmed.startsWith('--model=')
    || trimmed.startsWith('--model ')
    || trimmed.startsWith('-m ');
}

function isCodexProfileFlag(entry: string): boolean {
  const trimmed = entry.trim();
  return trimmed === '--profile'
    || trimmed === '-p'
    || trimmed.startsWith('--profile=')
    || trimmed.startsWith('--profile ')
    || trimmed.startsWith('-p ');
}

function isCodexKnownLaunchConfig(entry: string): boolean {
  const key = codexConfigKey(entry);
  return key === 'model' || key === 'model_reasoning_effort';
}

export function readCodexLaunchFlags(flags: string[]): CodexLaunchSelection {
  const selection: CodexLaunchSelection = {};

  for (const flag of flags) {
    const trimmed = flag.trim();
    const modelEquals = /^--model=(\S+)$/.exec(trimmed);
    const modelLong = /^--model\s+(\S+)$/.exec(trimmed);
    const modelShort = /^-m\s+(\S+)$/.exec(trimmed);
    const profileEquals = /^--profile=(\S+)$/.exec(trimmed);
    const profileLong = /^--profile\s+(\S+)$/.exec(trimmed);
    const profileShort = /^-p\s+(\S+)$/.exec(trimmed);
    const config = /^(?:-c|--config)(?:\s+|=)([^=\s]+)=(\S+)$/.exec(trimmed);

    if (modelEquals || modelLong || modelShort) {
      selection.model = (modelEquals || modelLong || modelShort)?.[1];
    } else if (profileEquals || profileLong || profileShort) {
      selection.profile = (profileEquals || profileLong || profileShort)?.[1];
    } else if (config?.[1] === 'model') {
      selection.model = config[2];
    } else if (config?.[1] === 'model_reasoning_effort' && CODEX_REASONING_EFFORTS.has(config[2] as CodexReasoningEffort)) {
      selection.reasoningEffort = config[2] as CodexReasoningEffort;
    }
  }

  return selection;
}

export function getCodexLaunchSettings(flags: string[]): { model?: string; reasoningEffort?: string; profile?: string } {
  const selection = readCodexLaunchFlags(flags);
  const result: { model?: string; reasoningEffort?: string; profile?: string } = {};
  if (selection.model && isSafeCodexLaunchValue(selection.model)) {
    result.model = selection.model;
  }
  if (selection.profile && isSafeCodexLaunchValue(selection.profile)) {
    result.profile = selection.profile;
  }
  if (selection.reasoningEffort && isSafeCodexLaunchValue(selection.reasoningEffort)) {
    result.reasoningEffort = selection.reasoningEffort;
  }
  return result;
}

export function updateCodexLaunchFlags(flags: string[], selection: CodexLaunchSelection): CodexLaunchFlagsUpdate {
  const hasUnsafeValue = [selection.model, selection.profile, selection.reasoningEffort]
    .some(value => value && !isSafeCodexLaunchValue(value));
  if (hasUnsafeValue) {
    return {
      flags: [...flags],
      conflict: 'Codex launch values can only use letters, numbers, dots, dashes, underscores, slashes, colons, plus, at signs, and tildes.',
    };
  }

  const wantsConfig = Boolean(selection.reasoningEffort);
  if (wantsConfig) {
    const ambiguousConfig = flags.find(flag => {
      const key = codexConfigKey(flag);
      return key !== null && !isCodexKnownLaunchConfig(flag);
    });
    if (ambiguousConfig) {
      return {
        flags: [...flags],
        conflict: `Manual config flag kept: ${ambiguousConfig}. Remove it before using the guided Codex controls.`,
      };
    }
  }

  const next = flags.filter(flag => {
    const trimmed = flag.trim();
    if (!trimmed) return false;
    return !isCodexModelFlag(trimmed)
      && !isCodexProfileFlag(trimmed)
      && !isCodexKnownLaunchConfig(trimmed);
  });

  if (selection.model) {
    next.push(`--model=${selection.model}`);
  }
  if (selection.profile) {
    next.push(`--profile=${selection.profile}`);
  }
  if (selection.reasoningEffort) {
    next.push(`-c model_reasoning_effort=${selection.reasoningEffort}`);
  }

  return { flags: next, conflict: null };
}
