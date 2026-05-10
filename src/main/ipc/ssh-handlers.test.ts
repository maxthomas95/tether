import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHarness, makeElectronMockBase, type IpcRegistry } from './ipc-test-harness.test-helper';

const registry = vi.hoisted<IpcRegistry>(() => ({ handlers: new Map(), listeners: new Map() }));
vi.mock('electron', () => makeElectronMockBase(registry));

const verifierMocks = vi.hoisted(() => ({
  setHostVerifyDispatcher: vi.fn(),
  respondToHostVerify: vi.fn(),
}));
vi.mock('../ssh/host-verifier', () => verifierMocks);

const knownHostsMocks = vi.hoisted(() => ({
  listKnownHosts: vi.fn(),
  deleteKnownHost: vi.fn(),
}));
vi.mock('../db/known-hosts-repo', () => knownHostsMocks);

import { IPC } from '../../shared/constants';
import { registerSshHandlers } from './ssh-handlers';

const harness = createHarness(registry);

describe('ssh-handlers', () => {
  beforeEach(() => {
    harness.reset();
    verifierMocks.setHostVerifyDispatcher.mockReset();
    verifierMocks.respondToHostVerify.mockReset();
    knownHostsMocks.listKnownHosts.mockReset();
    knownHostsMocks.deleteKnownHost.mockReset();
    registerSshHandlers(harness.ctx);
  });

  it('wires the host-verify dispatcher to push prompts to the renderer', () => {
    expect(verifierMocks.setHostVerifyDispatcher).toHaveBeenCalledTimes(1);
    const dispatcher = verifierMocks.setHostVerifyDispatcher.mock.calls[0][0] as (req: unknown) => void;
    const req = { token: 't', host: 'h', port: 22, keyHash: 'k' };
    dispatcher(req);
    expect(harness.send).toHaveBeenCalledWith(IPC.SSH_HOST_VERIFY_REQUEST, req);
  });

  it('SSH_HOST_VERIFY_RESPONSE forwards token + trust to the verifier', () => {
    harness.emit(IPC.SSH_HOST_VERIFY_RESPONSE, 'tok-1', true);
    expect(verifierMocks.respondToHostVerify).toHaveBeenCalledWith('tok-1', true);
  });

  it('KNOWN_HOSTS_LIST returns repo entries shaped as KnownHostInfo', async () => {
    knownHostsMocks.listKnownHosts.mockReturnValue([
      { id: 'h1', hostKey: 'host:22', keyHash: 'sha256:abc', keyType: 'rsa', trustedAt: 'a', firstSeen: 'b' },
    ]);
    const result = await harness.invoke(IPC.KNOWN_HOSTS_LIST);
    expect(result).toEqual([
      { id: 'h1', hostKey: 'host:22', keyHash: 'sha256:abc', keyType: 'rsa', trustedAt: 'a', firstSeen: 'b' },
    ]);
  });

  it('KNOWN_HOSTS_DELETE forwards id to the repo', async () => {
    await harness.invoke(IPC.KNOWN_HOSTS_DELETE, 'h-99');
    expect(knownHostsMocks.deleteKnownHost).toHaveBeenCalledWith('h-99');
  });
});
