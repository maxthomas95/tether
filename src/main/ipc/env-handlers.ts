import { ipcMain } from 'electron';
import { IPC } from '../../shared/constants';
import type { CreateEnvironmentOptions, EnvironmentInfo } from '../../shared/types';
import { sessionManager } from '../session/session-manager';
import * as envRepo from '../db/environment-repo';
import { createLogger } from '../logger';
import { encryptConfigPassword, decryptConfigPassword, type HandlerContext } from './helpers';

const log = createLogger('ipc:env');

export function registerEnvHandlers(_ctx: HandlerContext): void {
  ipcMain.handle(IPC.ENV_LIST, async () => {
    const envs = envRepo.listEnvironments();
    const sessions = sessionManager.listSessions();
    return envs.map((env): EnvironmentInfo => ({
      id: env.id,
      name: env.name,
      type: env.type as EnvironmentInfo['type'],
      config: decryptConfigPassword(JSON.parse(env.config)),
      envVars: JSON.parse(env.env_vars || '{}'),
      sessionCount: sessions.filter(s => {
        if (s.environmentId === env.id) return true;
        if (env.type === 'local' && !s.environmentId) return true;
        return false;
      }).length,
    }));
  });

  ipcMain.handle(IPC.ENV_CREATE, async (_event, opts: CreateEnvironmentOptions) => {
    log.info('Creating environment', { name: opts.name, type: opts.type });
    const env = envRepo.createEnvironment({
      name: opts.name,
      type: opts.type,
      config: encryptConfigPassword(opts.config),
      envVars: opts.envVars,
    });
    return {
      id: env.id,
      name: env.name,
      type: env.type,
      config: decryptConfigPassword(JSON.parse(env.config)),
      envVars: JSON.parse(env.env_vars || '{}'),
      sessionCount: 0,
    } as EnvironmentInfo;
  });

  ipcMain.handle(IPC.ENV_UPDATE, async (_event, id: string, opts: Partial<CreateEnvironmentOptions>) => {
    envRepo.updateEnvironment(id, {
      name: opts.name,
      type: opts.type,
      config: encryptConfigPassword(opts.config),
      envVars: opts.envVars,
    });
  });

  ipcMain.handle(IPC.ENV_DELETE, async (_event, id: string) => {
    log.info('Deleting environment', { id });
    envRepo.deleteEnvironment(id);
  });
}
