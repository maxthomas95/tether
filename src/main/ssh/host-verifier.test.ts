import { describe, expect, it, beforeEach, vi } from 'vitest';

const knownHostsMock = vi.hoisted(() => ({
  findKnownHost: vi.fn(),
  saveKnownHost: vi.fn(),
}));

vi.mock('../db/known-hosts-repo', () => knownHostsMock);

import { setHostVerifyDispatcher, verifyHost } from './host-verifier';

describe('host verifier', () => {
  beforeEach(() => {
    knownHostsMock.findKnownHost.mockReset();
    knownHostsMock.saveKnownHost.mockReset();
  });

  it('trusts an exact OpenSSH fingerprint match', async () => {
    knownHostsMock.findKnownHost.mockReturnValue({
      hostKey: 'box:22',
      keyHash: 'base64-sha',
      keyType: 'unknown',
    });
    await expect(verifyHost('box', 22, 'base64-sha')).resolves.toEqual({ trust: true });
    expect(knownHostsMock.saveKnownHost).not.toHaveBeenCalled();
  });

  it('trusts and migrates a legacy hex match', async () => {
    knownHostsMock.findKnownHost.mockReturnValue({
      hostKey: 'box:22',
      keyHash: 'legacyhex',
      keyType: 'ssh-ed25519',
    });
    await expect(verifyHost('box', 22, 'base64-sha', 'me', 'legacyhex')).resolves.toEqual({ trust: true });
    expect(knownHostsMock.saveKnownHost).toHaveBeenCalledWith({
      hostKey: 'box:22',
      keyHash: 'base64-sha',
      keyType: 'ssh-ed25519',
    });
  });

  it('sends OpenSSH fingerprint bodies to the renderer prompt', async () => {
    knownHostsMock.findKnownHost.mockReturnValue(undefined);
    let requestToken = '';
    setHostVerifyDispatcher((req) => {
      requestToken = req.token;
      expect(req.keyHash).toBe('base64-sha');
    });
    const promise = verifyHost('box', 22, 'base64-sha');
    const { respondToHostVerify } = await import('./host-verifier');
    respondToHostVerify(requestToken, false);
    await expect(promise).resolves.toMatchObject({ trust: false });
  });
});

