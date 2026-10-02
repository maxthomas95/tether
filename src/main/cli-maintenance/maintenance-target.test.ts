import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ session: vi.fn(), environment: vi.fn(), resolve: vi.fn(), sshConfig: vi.fn(),
  local: vi.fn(), ssh: vi.fn(), coder: vi.fn(), db: { defaultEnvVars: { PATH: '/app/bin', CODEX_HOME: '/app/home' } } }));
vi.mock('../db/database', () => ({ getDb: () => mocks.db }));
vi.mock('../db/environment-repo', () => ({ getEnvironment: mocks.environment }));
vi.mock('../db/secret-storage', () => ({ decryptEnvVarsRecord: (value: unknown) => value }));
vi.mock('../vault/vault-resolver', () => ({ resolveAll: mocks.resolve }));
vi.mock('../ssh/resolve-ssh-config', () => ({ resolveSshConfig: mocks.sshConfig }));
vi.mock('../session/session-manager', () => ({ sessionManager: { getSession: mocks.session } }));
vi.mock('../transport/local-transport', () => ({ LocalTransport: class { constructor() { mocks.local(); } } }));
vi.mock('../transport/ssh-transport', () => ({ SSHTransport: class { constructor(config: unknown) { mocks.ssh(config); } } }));
vi.mock('../transport/coder-transport', () => ({ CoderTransport: class { constructor(config: unknown) { mocks.coder(config); } } }));
import { maintenanceTarget } from './maintenance-target';
import type { CliMaintenanceRequest } from '../../shared/cli-maintenance';
const request: CliMaintenanceRequest = { id: '11111111-1111-4111-a111-111111111111', tool: 'claude', action: 'check', method: 'native' };

describe('maintenance environment selection', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.session.mockReturnValue(undefined); mocks.environment.mockReturnValue(undefined);
    mocks.resolve.mockImplementation(async value => value); mocks.sshConfig.mockImplementation(async value => ({ ...value, verified: true })); });
  it('resolves app and environment vars and uses the secure SSH transport config', async () => {
    mocks.environment.mockReturnValue({ type: 'ssh', config: JSON.stringify({ host: 'host', useSudo: true }), env_vars: JSON.stringify({ PATH: '/remote/bin', CLAUDE_CONFIG_DIR: '/remote/claude' }) });
    const target = maintenanceTarget({ ...request, environmentId: 'remote' });
    expect(await target.env()).toEqual({ PATH: '/remote/bin', CODEX_HOME: '/app/home', CLAUDE_CONFIG_DIR: '/remote/claude' });
    expect(target.workingDir).toBe('~');
    await target.transport();
    expect(mocks.ssh).toHaveBeenCalledWith({ host: 'host', useSudo: true, verified: true });
    expect(mocks.local).not.toHaveBeenCalled();
  });
  it('uses the session launch context and keeps secrets in main, without resolving new defaults', async () => {
    mocks.session.mockReturnValue({ environmentId: 'remote', workingDir: '/projects/with spaces', maintenanceEnv: { PATH: '/profile/bin', CLAUDE_CONFIG_DIR: '/custom', TOKEN: 'runtime-only' } });
    mocks.environment.mockReturnValue({ type: 'ssh', config: '{}', env_vars: '{}' });
    const target = maintenanceTarget({ ...request, sessionId: 'session', environmentId: 'another-host' });
    expect(target.workingDir).toBe('/projects/with spaces');
    expect(await target.env()).toEqual({ PATH: '/profile/bin', CLAUDE_CONFIG_DIR: '/custom', TOKEN: 'runtime-only' });
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.environment).toHaveBeenCalledWith('remote');
  });
  it('requires a Coder workspace and never falls back to a local CLI for a deleted target', async () => {
    expect(() => maintenanceTarget({ ...request, environmentId: 'deleted' })).toThrow('no longer available');
    expect(() => maintenanceTarget({ ...request, sessionId: 'deleted' })).toThrow('no longer available');
    mocks.environment.mockReturnValue({ type: 'coder', config: JSON.stringify({ binaryPath: '/trusted/coder' }) });
    expect(() => maintenanceTarget({ ...request, environmentId: 'coder' })).toThrow('workspace');
    const target = maintenanceTarget({ ...request, environmentId: 'coder', workspace: 'owner/workspace' });
    expect(target.workingDir).toBe('owner/workspace');
    await target.transport();
    expect(mocks.coder).toHaveBeenCalledWith({ binaryPath: '/trusted/coder' });
    expect(mocks.local).not.toHaveBeenCalled();
  });
});
