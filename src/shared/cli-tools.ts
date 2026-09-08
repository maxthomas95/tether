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

export type CodexReasoningEffort = string;

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
const CODEX_MAX_LAUNCH_VALUE_LENGTH = 128;

export function isSafeCodexLaunchValue(value: string): boolean {
  return value.length > 0 && !value.startsWith('-') && value.length <= CODEX_MAX_LAUNCH_VALUE_LENGTH && CODEX_SAFE_VALUE_RE.test(value);
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

function hasMultipleCodexFlags(entry: string): boolean {
  const flags = entry.match(/(?:^|\s)-{1,2}[A-Za-z][^\s=]*/g);
  return (flags?.length ?? 0) > 1;
}

function unquoteCodexValue(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readKnownCodexEntry(entry: string): { key: keyof CodexLaunchSelection; value: string } | { key: null; value: null; ambiguous: boolean } {
  const trimmed = entry.trim();
  if (!trimmed || hasMultipleCodexFlags(trimmed)) return { key: null, value: null, ambiguous: true };
  const modelEquals = /^--model=(.+)$/.exec(trimmed);
  const modelLong = /^--model\s+(.+)$/.exec(trimmed);
  const modelShort = /^-m\s+(.+)$/.exec(trimmed);
  const profileEquals = /^--profile=(.+)$/.exec(trimmed);
  const profileLong = /^--profile\s+(.+)$/.exec(trimmed);
  const profileShort = /^-p\s+(.+)$/.exec(trimmed);
  const config = /^(?:-c|--config)(?:\s+|=)([^=\s]+)=(.+)$/.exec(trimmed);

  if (modelEquals || modelLong || modelShort) {
    return { key: 'model', value: unquoteCodexValue((modelEquals || modelLong || modelShort)?.[1] || '') };
  }
  if (profileEquals || profileLong || profileShort) {
    return { key: 'profile', value: unquoteCodexValue((profileEquals || profileLong || profileShort)?.[1] || '') };
  }
  if (config?.[1] === 'model') {
    return { key: 'model', value: unquoteCodexValue(config[2]) };
  }
  if (config?.[1] === 'model_reasoning_effort') {
    return { key: 'reasoningEffort', value: unquoteCodexValue(config[2]) };
  }
  return { key: null, value: null, ambiguous: false };
}

export function readCodexLaunchFlags(flags: string[]): CodexLaunchSelection {
  const selection: CodexLaunchSelection = {};

  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    const trimmed = flag.trim();
    if (trimmed === '--model' || trimmed === '-m' || trimmed === '--profile' || trimmed === '-p') {
      const next = flags[index + 1]?.trim();
      if (next && isSafeCodexLaunchValue(unquoteCodexValue(next))) {
        selection[trimmed === '--model' || trimmed === '-m' ? 'model' : 'profile'] = unquoteCodexValue(next);
        index += 1;
      }
      continue;
    }
    if (trimmed === '-c' || trimmed === '--config') {
      const config = /^([^=\s]+)=(.+)$/.exec(flags[index + 1]?.trim() || '');
      if (config?.[1] === 'model' && isSafeCodexLaunchValue(unquoteCodexValue(config[2]))) {
        selection.model = unquoteCodexValue(config[2]);
        index += 1;
      } else if (config?.[1] === 'model_reasoning_effort' && isSafeCodexLaunchValue(unquoteCodexValue(config[2]))) {
        selection.reasoningEffort = unquoteCodexValue(config[2]);
        index += 1;
      }
      continue;
    }

    const known = readKnownCodexEntry(trimmed);
    if (known.key && isSafeCodexLaunchValue(known.value)) {
      selection[known.key] = known.value;
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

  const next: string[] = [];
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    const trimmed = flag.trim();
    if (!trimmed) {
      next.push(flag);
      continue;
    }
    if (hasMultipleCodexFlags(trimmed)) {
      return {
        flags: [...flags],
        conflict: `Manual Codex launch entry kept: ${flag}. Split it into one setting per entry before using guided controls.`,
      };
    }
    if (trimmed === '--model' || trimmed === '-m' || trimmed === '--profile' || trimmed === '-p') {
      const value = flags[index + 1]?.trim();
      if (!value || !isSafeCodexLaunchValue(unquoteCodexValue(value))) {
        return {
          flags: [...flags],
          conflict: `Manual Codex launch entry kept: ${flag}. Remove it before using guided controls.`,
        };
      }
      index += 1;
      continue;
    }
    if (trimmed === '-c' || trimmed === '--config') {
      const config = /^([^=\s]+)=(.+)$/.exec(flags[index + 1]?.trim() || '');
      if (config?.[1] === 'model' || config?.[1] === 'model_reasoning_effort') {
        if (!isSafeCodexLaunchValue(unquoteCodexValue(config[2]))) {
          return {
            flags: [...flags],
            conflict: `Manual Codex launch entry kept: ${flag} ${flags[index + 1] || ''}. Remove it before using guided controls.`,
          };
        }
        index += 1;
        continue;
      }
      next.push(flag);
      continue;
    }
    const known = readKnownCodexEntry(trimmed);
    if (known.key && isSafeCodexLaunchValue(known.value)) {
      continue;
    }
    if (isCodexModelFlag(trimmed) || isCodexProfileFlag(trimmed) || isCodexKnownLaunchConfig(trimmed)) {
      return {
        flags: [...flags],
        conflict: `Manual Codex launch entry kept: ${flag}. Remove it before using guided controls.`,
      };
    }
    next.push(flag);
  }

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
