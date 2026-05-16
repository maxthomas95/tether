import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SessionTransport, TransportExitInfo, TransportStartOptions } from '../transport/types';

const transportHarness = vi.hoisted(() => {
  const state = {
    instances: [] as Array<{
      start: ReturnType<typeof vi.fn>;
      dispose: ReturnType<typeof vi.fn>;
      onData: ReturnType<typeof vi.fn>;
      onExit: ReturnType<typeof vi.fn>;
    }>,
    startImpl: vi.fn(async () => undefined),
  };

  class FakeLocalTransport implements SessionTransport {
    start = vi.fn((options: TransportStartOptions) => state.startImpl(options));
    write = vi.fn();
    resize = vi.fn();
    stop = vi.fn(async () => undefined);
    kill = vi.fn();
    onData = vi.fn();
    onExit = vi.fn();
    dispose = vi.fn();
    connected = false;

    constructor() {
      state.instances.push(this);
    }
  }

  return { state, FakeLocalTransport };
});

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    decryptString: () => '',
  },
}));

vi.mock('../transport/local-transport', () => ({
  LocalTransport: transportHarness.FakeLocalTransport,
}));

vi.mock('../transport/ssh-transport', () => ({
  SSHTransport: vi.fn(),
}));

vi.mock('../transport/coder-transport', () => ({
  CoderTransport: vi.fn(),
}));

vi.mock('../db/database', () => ({
  getDb: () => ({
    config: {},
    defaultEnvVars: {},
    defaultCliFlagsPerTool: {},
  }),
}));

vi.mock('../db/environment-repo', () => ({
  getEnvironment: () => undefined,
  listEnvironments: () => [],
}));

vi.mock('../db/profile-repo', () => ({
  getProfile: () => undefined,
  listProfiles: () => [],
}));

vi.mock('../vault/vault-resolver', () => ({
  isVaultRef: () => false,
  resolveRef: vi.fn(),
  resolveAll: async (env: Record<string, string>) => env,
}));

vi.mock('../claude/transcripts', () => ({
  transcriptExists: () => false,
}));

vi.mock('../codex/transcripts', () => ({
  codexTranscriptExists: () => false,
}));

vi.mock('../codex/session-watcher', () => ({
  detectNewCodexSession: vi.fn(),
  releaseCodexSessionClaim: vi.fn(),
}));

vi.mock('../copilot/transcripts', () => ({
  copilotTranscriptExists: () => false,
}));

vi.mock('../copilot/session-watcher', () => ({
  detectNewCopilotSession: vi.fn(),
  releaseCopilotSessionClaim: vi.fn(),
}));

vi.mock('../opencode/transcripts', () => ({
  opencodeTranscriptExists: () => false,
}));

vi.mock('../opencode/session-watcher', () => ({
  detectNewOpencodeSession: vi.fn(),
  releaseOpencodeSessionClaim: vi.fn(),
}));

vi.mock('../helm/integration', () => ({
  setupHelmForSession: vi.fn(),
}));

vi.mock('../usage/usage-service', () => ({
  usageService: {
    trackSession: vi.fn(),
  },
}));

vi.mock('../coder/workspace-service', () => ({
  createCoderWorkspace: vi.fn(),
  listCoderWorkspaces: vi.fn(),
  listCoderTemplates: vi.fn(),
  getCoderTemplateParams: vi.fn(),
}));

import { SessionManager } from './session-manager';

function callbacks() {
  return {
    onData: vi.fn(),
    onStateChange: vi.fn(),
    onExit: vi.fn((_sessionId: string, _exitInfo: TransportExitInfo) => undefined),
    onUpdate: vi.fn(),
  };
}

describe('SessionManager', () => {
  let manager: SessionManager;

  beforeEach(() => {
    transportHarness.state.instances.length = 0;
    transportHarness.state.startImpl.mockReset();
    transportHarness.state.startImpl.mockResolvedValue(undefined);
    manager = new SessionManager();
  });

  afterEach(() => {
    manager.dispose();
  });

  it('cleans up a session when transport.start rejects', async () => {
    transportHarness.state.startImpl.mockRejectedValue(new Error('spawn failed'));
    const cb = callbacks();

    await expect(manager.createSession({
      workingDir: 'C:\\repo\\missing',
      cliTool: 'claude',
    }, cb)).rejects.toThrow(/spawn failed/);

    expect(manager.listSessions()).toEqual([]);
    expect(transportHarness.state.instances).toHaveLength(1);
    expect(transportHarness.state.instances[0].dispose).toHaveBeenCalled();
    expect(cb.onExit).not.toHaveBeenCalled();
  });
});
