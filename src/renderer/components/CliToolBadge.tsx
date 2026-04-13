import { CLI_TOOL_REGISTRY, type CliToolId } from '../../shared/cli-tools';
import type { SessionInfo } from '../../shared/types';

const BADGE_LABELS: Record<CliToolId, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  custom: 'Custom',
};

interface CliToolBadgeProps {
  session: Pick<SessionInfo, 'cliTool' | 'customCliBinary'>;
}

export function CliToolBadge({ session }: CliToolBadgeProps) {
  const cliTool = session.cliTool ?? 'claude';
  const tool = CLI_TOOL_REGISTRY[cliTool];
  const label = cliTool === 'custom'
    ? session.customCliBinary?.trim() || BADGE_LABELS.custom
    : BADGE_LABELS[cliTool];
  const title = cliTool === 'custom'
    ? `Custom CLI${session.customCliBinary ? `: ${session.customCliBinary}` : ''}`
    : tool.displayName;

  return (
    <span
      className={`cli-tool-badge cli-tool-badge--${cliTool}`}
      title={title}
      aria-label={title}
    >
      {label}
    </span>
  );
}
