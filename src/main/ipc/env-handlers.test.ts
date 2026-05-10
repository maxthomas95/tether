import { describe, it, expect, beforeEach, vi } from 'vitest';

const registry = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  listeners: new Map<string, (event: unknown, ...args: unknown[]) => void>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (event: unknown, ...args: unknown[]) => unknown) => { registry.handlers.set(ch, fn); },
    on: (ch: string, fn: (event: unknown, ...args: unknown[]) => void) => { registry.listeners.set(ch, fn); },
  },
  // safeStorage is referenced via helpers.ts (encrypt/decrypt). Mark unavailable
  // so password handling falls through cleanly.
  safeStorage: { isEncryptionAvailable: () => false, encryptString: vi.fn(), decryptString: vi.fn() },
}));

const envMocks = vi.hoisted(() => ({
  listEnvironments: vi.fn(),
  createEnvironment: vi.fn(),
  updateEnvironment: vi.fn(),
  deleteEnvironment: vi.fn(),
}));
vi.mock('../db/environment-repo', () => envMocks);

const sessionManagerMock = vi.hoisted(() => ({ listSessions: vi.fn().mockReturnValue([]) }));
vi.mock('../session/session-manager', () => ({ sessionManager: sessionManagerMock }));

import { IPC } from '../../shared/constants';
import { registerEnvHandlers } from './env-handlers';
import { createHarness } from './ipc-test-harness.test-helper';

const harness = createHarness(registry);

const fakeRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'e1',
  name: 'Local',
  type: 'local',
  config: '{}',
  env_vars: '{}',
  ...overrides,
});

describe('env-handlers', () => {
  beforeEach(() => {
    harness.reset();
    Object.values(envMocks).forEach((m) => m.mockReset());
    sessionManagerMock.listSessions.mockReset();
    sessionManagerMock.listSessions.mockReturnValue([]);
    registerEnvHandlers(harness.ctx);
  });

  it('ENV_LIST returns rows with parsed JSON + counted sessions', async () => {
    envMocks.listEnvironments.mockReturnValue([
      fakeRow({ id: 'e1', type: 'local', env_vars: '{"K":"v"}' }),
      fakeRow({ id: 'e2', type: 'ssh', config: '{"host":"box"}' }),
    ]);
    sessionManagerMock.listSessions.mockReturnValue([
      { environmentId: 'e1' },
      { environmentId: undefined }, // counts as local (no env id)
      { environmentId: 'e2' },
    ]);
    const result = await harness.invoke<Array<{ id: string; sessionCount: number; envVars: Record<string, string>; config: Record<string, unknown> }>>(IPC.ENV_LIST);
    expect(result).toHaveLength(2);
    const local = result.find(r => r.id === 'e1')!;
    expect(local.sessionCount).toBe(2); // direct + unassigned-local
    expect(local.envVars).toEqual({ K: 'v' });
    const ssh = result.find(r => r.id === 'e2')!;
    expect(ssh.sessionCount).toBe(1);
    expect(ssh.config).toEqual({ host: 'box' });
  });

  it('ENV_CREATE forwards opts to repo and returns parsed info', async () => {
    envMocks.createEnvironment.mockReturnValue(fakeRow({ id: 'e3', name: 'New', type: 'local' }));
    const opts = { name: 'New', type: 'local' as const, config: { host: 'h' }, envVars: { K: 'v' } };
    const result = await harness.invoke<{ id: string; name: string }>(IPC.ENV_CREATE, opts);
    expect(envMocks.createEnvironment).toHaveBeenCalledWith({
      name: 'New',
      type: 'local',
      config: { host: 'h' },     // safeStorage.isEncryptionAvailable() returns false → pass-through
      envVars: { K: 'v' },
    });
    expect(result.id).toBe('e3');
  });

  it('ENV_UPDATE forwards id and opts', async () => {
    await harness.invoke(IPC.ENV_UPDATE, 'e1', { name: 'Renamed' });
    expect(envMocks.updateEnvironment).toHaveBeenCalledWith('e1', expect.objectContaining({ name: 'Renamed' }));
  });

  it('ENV_DELETE forwards id', async () => {
    await harness.invoke(IPC.ENV_DELETE, 'e1');
    expect(envMocks.deleteEnvironment).toHaveBeenCalledWith('e1');
  });
});
