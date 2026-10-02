import os from 'node:os';
import { getDb } from '../db/database';
import { getEnvironment } from '../db/environment-repo';
import { decryptEnvVarsRecord } from '../db/secret-storage';
import { resolveAll } from '../vault/vault-resolver';
import { resolveSshConfig } from '../ssh/resolve-ssh-config';
import { LocalTransport } from '../transport/local-transport';
import { SSHTransport } from '../transport/ssh-transport';
import { CoderTransport } from '../transport/coder-transport';
import { sessionManager } from '../session/session-manager';
import type { CliMaintenanceRequest } from '../../shared/cli-maintenance';
import type { MaintenanceTarget } from './maintenance-manager';

export function maintenanceTarget(request: CliMaintenanceRequest): MaintenanceTarget {
  const session = request.sessionId ? sessionManager.getSession(request.sessionId) : undefined;
  if (request.sessionId && !session) throw new Error('The selected session is no longer available.');
  const environmentId = session ? session.environmentId ?? undefined : request.environmentId;
  const environment = environmentId ? getEnvironment(environmentId) : undefined;
  if (environmentId && !environment) throw new Error('The selected environment is no longer available.');
  const type = environment?.type ?? 'local';
  const config = JSON.parse(environment?.config || '{}') as Record<string, unknown>;
  const workingDir = session?.workingDir ?? (type === 'coder' ? request.workspace : type === 'ssh' ? '~' : os.homedir());
  if (!workingDir || (type === 'coder' && (workingDir.includes('::') && !session))) throw new Error('Choose a Coder workspace.');
  const workspace = type === 'coder' ? workingDir.split('::')[0] : '';
  if (type === 'coder' && (!/^[a-z0-9_][a-z0-9_.@/-]*$/i.test(workspace) || workspace.includes('..'))) throw new Error('Choose a valid Coder workspace.');
  return {
    key: `${type === 'local' ? 'local' : environmentId}:${workspace}`,
    workingDir,
    windows: type === 'local' && process.platform === 'win32',
    env: () => session
      ? Promise.resolve({ ...session.maintenanceEnv })
      : resolveAll({ ...decryptEnvVarsRecord(getDb().defaultEnvVars || {}), ...JSON.parse(environment?.env_vars || '{}') }),
    transport: async () => {
      if (type === 'ssh') return new SSHTransport(await resolveSshConfig(config));
      if (type === 'coder') return new CoderTransport({ binaryPath: typeof config.binaryPath === 'string' ? config.binaryPath : undefined });
      return new LocalTransport();
    },
  };
}
