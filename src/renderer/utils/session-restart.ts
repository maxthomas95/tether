import { toolSupportsResume } from '../../shared/cli-tools';
import type { CreateSessionOptions, SessionInfo } from '../../shared/types';

/** Carry the native conversation id across a new transport/PTY instance. */
export function buildSessionRestartOptions(session: SessionInfo): CreateSessionOptions {
  const cliTool = session.cliTool || 'claude';
  const nativeId = session.toolSessionId || (cliTool === 'claude' ? session.claudeSessionId : undefined);
  return {
    workingDir: session.workingDir,
    label: session.label,
    environmentId: session.environmentId || undefined,
    cliTool: session.cliTool,
    customCliBinary: session.customCliBinary || undefined,
    worktreeOf: session.worktreeOf,
    helmEnabled: session.helmEnabled,
    resumeToolSessionId: toolSupportsResume(cliTool) ? nativeId : undefined,
  };
}
