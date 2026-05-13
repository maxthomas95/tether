import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHarness, makeElectronMockBase, type IpcRegistry } from './ipc-test-harness.test-helper';

const registry = vi.hoisted<IpcRegistry>(() => ({ handlers: new Map(), listeners: new Map() }));
vi.mock('electron', () => makeElectronMockBase(registry));

const profileMocks = vi.hoisted(() => ({
  listProfiles: vi.fn(),
  createProfile: vi.fn(),
  updateProfile: vi.fn(),
  deleteProfile: vi.fn(),
}));
vi.mock('../db/profile-repo', () => profileMocks);

import { IPC } from '../../shared/constants';
import { registerProfileHandlers } from './profile-handlers';

const harness = createHarness(registry);

const fakeRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'p1',
  name: 'Default',
  env_vars: '{"FOO":"bar"}',
  cli_flags: '["--model","sonnet"]',
  cli_flags_per_tool: '{"claude":["--model","sonnet"]}',
  is_default: true,
  ...overrides,
});

describe('profile-handlers', () => {
  beforeEach(() => {
    harness.reset();
    Object.values(profileMocks).forEach((m) => m.mockReset());
    registerProfileHandlers(harness.ctx);
  });

  it('PROFILE_LIST maps repo rows into LaunchProfileInfo (parsing JSON columns)', async () => {
    profileMocks.listProfiles.mockReturnValue([fakeRow()]);
    const result = await harness.invoke<unknown[]>(IPC.PROFILE_LIST);
    expect(result).toEqual([{
      id: 'p1',
      name: 'Default',
      envVars: { FOO: 'bar' },
      cliFlagsPerTool: { claude: ['--model', 'sonnet'] },
      cliFlags: ['--model', 'sonnet'],
      isDefault: true,
    }]);
  });

  it('PROFILE_CREATE forwards opts and returns parsed info', async () => {
    profileMocks.createProfile.mockReturnValue(fakeRow({ id: 'p2', name: 'Custom' }));
    const opts = { name: 'Custom', envVars: { K: 'v' }, cliFlags: ['--x'], cliFlagsPerTool: { claude: ['--x'] }, isDefault: false };
    const result = await harness.invoke<{ id: string; name: string }>(IPC.PROFILE_CREATE, opts);
    expect(profileMocks.createProfile).toHaveBeenCalledWith(opts);
    expect(result.id).toBe('p2');
    expect(result.name).toBe('Custom');
  });

  it('PROFILE_UPDATE forwards id and partial opts', async () => {
    await harness.invoke(IPC.PROFILE_UPDATE, 'p1', { name: 'Renamed' });
    expect(profileMocks.updateProfile).toHaveBeenCalledWith('p1', expect.objectContaining({ name: 'Renamed' }));
  });

  it('PROFILE_DELETE forwards id', async () => {
    await harness.invoke(IPC.PROFILE_DELETE, 'p1');
    expect(profileMocks.deleteProfile).toHaveBeenCalledWith('p1');
  });
});
