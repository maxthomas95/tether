import type { CliToolId, CreateLaunchProfileOptions } from '../../shared/types';

/** CLI tools that have definable flags (exclude 'custom' which has no known flags). */
export const FLAG_TOOLS = (['claude', 'codex', 'copilot', 'opencode'] as const) satisfies readonly CliToolId[];

export function compactFlagsPerTool(flags: Partial<Record<CliToolId, string[]>>): Partial<Record<CliToolId, string[]>> {
  const result: Partial<Record<CliToolId, string[]>> = {};
  for (const toolId of FLAG_TOOLS) {
    const toolFlags = flags[toolId]?.filter(Boolean) || [];
    if (toolFlags.length > 0) {
      result[toolId] = toolFlags;
    }
  }
  return result;
}

export function buildLaunchProfileOptions(
  name: string,
  envVars: Record<string, string>,
  flagsPerTool: Partial<Record<CliToolId, string[]>>,
): CreateLaunchProfileOptions {
  const cliFlagsPerTool = compactFlagsPerTool(flagsPerTool);
  // updateProfile treats undefined as "keep", so a list emptied in the editor must be sent as empty.
  return { name: name.trim(), envVars, cliFlagsPerTool, cliFlags: cliFlagsPerTool.claude ?? [] };
}
