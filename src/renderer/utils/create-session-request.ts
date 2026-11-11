import type { CliToolId, CreateSessionOptions, SessionInfo } from '../../shared/types';

/** What the New Session dialog has collected, in the shapes its controls hold. */
export interface LaunchFormValues {
  workingDir: string;
  label: string;
  environmentId: string;
  env: Record<string, string>;
  cliArgs: string[];
  disabledFlags: ReadonlySet<string>;
  profileId: string | null;
  cliTool: CliToolId;
  customBinary: string;
  helmEnabled: boolean;
}

/**
 * Turn dialog state into a create request. Empty selections are omitted so the
 * main process applies its own defaults instead of receiving empty overrides.
 */
export function buildLaunchRequest(form: LaunchFormValues, extra: Partial<CreateSessionOptions> = {}): CreateSessionOptions {
  return {
    workingDir: form.workingDir,
    label: form.label,
    environmentId: form.environmentId || undefined,
    env: Object.keys(form.env).length > 0 ? form.env : undefined,
    cliArgs: form.cliArgs.length > 0 ? form.cliArgs : undefined,
    disabledInheritedFlags: form.disabledFlags.size > 0 ? Array.from(form.disabledFlags) : undefined,
    profileId: form.profileId || undefined,
    cliTool: form.cliTool,
    customCliBinary: form.cliTool === 'custom' ? form.customBinary : undefined,
    helmEnabled: form.helmEnabled || undefined,
    ...extra,
  };
}

/**
 * Start another session the way `source` was started. Its saved launch
 * settings (profile, env, flags) travel by snapshot id, so a session launched
 * under an API-key or model profile is not relaunched under the defaults.
 */
export function relaunchRequest(
  source: Pick<SessionInfo, 'workingDir' | 'environmentId' | 'cliTool' | 'customCliBinary' | 'helmEnabled' | 'launchSnapshotId'>,
  extra: Partial<CreateSessionOptions> = {},
): CreateSessionOptions {
  return {
    workingDir: source.workingDir,
    environmentId: source.environmentId || undefined,
    cliTool: source.cliTool,
    customCliBinary: source.customCliBinary,
    helmEnabled: source.helmEnabled,
    launchSnapshotId: source.launchSnapshotId,
    ...extra,
  };
}

/** Blank labels fall back to the default name; Claude resumes also set the legacy alias. */
export function withLegacyClaudeResume(request: CreateSessionOptions): CreateSessionOptions {
  const isClaude = !request.cliTool || request.cliTool === 'claude';
  return {
    ...request,
    label: request.label || undefined,
    resumeClaudeSessionId: isClaude ? request.resumeToolSessionId : undefined,
  };
}
