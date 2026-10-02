import { createTrustedIpc } from './trusted-ipc';
import { IPC } from '../../shared/constants';
import type { CreateLaunchProfileOptions, LaunchProfileInfo } from '../../shared/types';
import * as profileRepo from '../db/profile-repo';
import type { HandlerContext } from './helpers';

export function registerProfileHandlers(_ctx: HandlerContext): void {
  const ipc = createTrustedIpc(_ctx.mainWindow);
  ipc.handle(IPC.PROFILE_LIST, async () => {
    return profileRepo.listProfiles().map((p): LaunchProfileInfo => ({
      id: p.id,
      name: p.name,
      envVars: JSON.parse(p.env_vars || '{}'),
      cliFlagsPerTool: JSON.parse(p.cli_flags_per_tool || '{}'),
      cliFlags: JSON.parse(p.cli_flags || '[]'),
      isDefault: p.is_default,
    }));
  });

  ipc.handle(IPC.PROFILE_CREATE, async (_event, opts: CreateLaunchProfileOptions) => {
    const p = profileRepo.createProfile({
      name: opts.name,
      envVars: opts.envVars,
      cliFlagsPerTool: opts.cliFlagsPerTool,
      cliFlags: opts.cliFlags,
      isDefault: opts.isDefault,
    });
    return {
      id: p.id,
      name: p.name,
      envVars: JSON.parse(p.env_vars || '{}'),
      cliFlagsPerTool: JSON.parse(p.cli_flags_per_tool || '{}'),
      cliFlags: JSON.parse(p.cli_flags || '[]'),
      isDefault: p.is_default,
    } as LaunchProfileInfo;
  });

  ipc.handle(IPC.PROFILE_UPDATE, async (_event, id: string, opts: Partial<CreateLaunchProfileOptions>) => {
    profileRepo.updateProfile(id, {
      name: opts.name,
      envVars: opts.envVars,
      cliFlagsPerTool: opts.cliFlagsPerTool,
      cliFlags: opts.cliFlags,
      isDefault: opts.isDefault,
    });
  });

  ipc.handle(IPC.PROFILE_DELETE, async (_event, id: string) => {
    profileRepo.deleteProfile(id);
  });
}
