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

  class FakeRemoteTransport implements SessionTransport {
    start = vi.fn((options: TransportStartOptions) => state.startImpl(options));
    write = vi.fn();
    resize = vi.fn();
    stop = vi.fn(async () => undefined);
    kill = vi.fn();
    onData = vi.fn();
    onExit = vi.fn();
    dispose = vi.fn();
    connected = false;
    constructor() { state.instances.push(this); }
  }
  class FakeSshTransport extends FakeRemoteTransport {}
  class FakeCoderTransport extends FakeRemoteTransport {}
  return { state, FakeLocalTransport, FakeSshTransport, FakeCoderTransport };
});

const safeStorageState = vi.hoisted(() => ({
  available: true,
  decryptFails: false,
}));

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => safeStorageState.available,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value: Buffer) => {
      if (safeStorageState.decryptFails) throw new Error('decrypt failed');
      return value.toString('utf8').replace(/^encrypted:/, '');
    },
  },
}));

vi.mock('../transport/local-transport', () => ({
  LocalTransport: transportHarness.FakeLocalTransport,
}));

vi.mock('../transport/ssh-transport', () => ({
  SSHTransport: transportHarness.FakeSshTransport,
}));

vi.mock('../transport/coder-transport', () => ({
  CoderTransport: transportHarness.FakeCoderTransport,
}));

const dbState = vi.hoisted(() => ({
  config: {} as Record<string, string>,
  defaultEnvVars: {} as Record<string, string>,
  defaultCliFlagsPerTool: {} as Record<string, string[]>,
  launchSnapshots: {} as Record<string, { id: string; version: 1; encryptedIntent: string; createdAt: string; updatedAt: string }>,
  saveCount: 0,
}));

vi.mock('../db/database', () => ({
  getDb: () => dbState,
  saveDb: () => { dbState.saveCount += 1; },
}));

const envState = vi.hoisted(() => ({ type: '' }));
vi.mock('../db/environment-repo', () => ({
  getEnvironment: () => envState.type ? { id: 'env', type: envState.type, config: '{}', env_vars: '{}' } : undefined,
  listEnvironments: () => [],
}));

const profileState = vi.hoisted(() => ({
  profiles: [] as Array<{ id: string; name: string; env_vars: string; cli_flags: string; cli_flags_per_tool: string; is_default?: boolean }>,
}));

vi.mock('../db/profile-repo', () => ({
  getProfile: (id: string) => profileState.profiles.find(p => p.id === id),
  listProfiles: () => profileState.profiles,
}));

vi.mock('../vault/vault-resolver', () => ({
  isVaultRef: (value: string) => typeof value === 'string' && value.startsWith('vault://'),
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
  detectNewCodexSession: vi.fn(() => ({ cancel: vi.fn(), promise: new Promise<string | null>(() => undefined) })),
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

const helmHarness = vi.hoisted(() => ({
  capturedHandlers: null as Record<string, (params: Record<string, unknown>) => Promise<unknown>> | null,
  setup: vi.fn(),
}));

vi.mock('../helm/integration', () => ({
  setupHelmForSession: helmHarness.setup,
}));

vi.mock('../usage/usage-service', () => ({
  usageService: {
    trackSession: vi.fn(),
  },
}));
vi.mock('../usage/remote-usage-service', () => ({ remoteUsageService: { start: vi.fn(), stop: vi.fn(), dispose: vi.fn() } }));
vi.mock('../ssh/resolve-ssh-config', () => ({ resolveSshConfig: vi.fn(async () => ({ host: 'test', port: 22, username: 'user' })) }));

vi.mock('../coder/workspace-service', () => ({
  createCoderWorkspace: vi.fn(),
  listCoderWorkspaces: vi.fn(),
  listCoderTemplates: vi.fn(),
  getCoderTemplateParams: vi.fn(),
}));

import { SessionManager, findVaultRefInSession, setHelmChildCallbacks } from './session-manager';
import { remoteUsageService } from '../usage/remote-usage-service';
import { buildSessionRestartOptions } from '../../renderer/utils/session-restart';
import { statusDetector } from '../status/status-detector';

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
    envState.type = '';
    vi.mocked(remoteUsageService.start).mockClear();
    vi.mocked(remoteUsageService.stop).mockClear();
    transportHarness.state.instances.length = 0;
    transportHarness.state.startImpl.mockReset();
    transportHarness.state.startImpl.mockResolvedValue(undefined);
    dbState.config = {};
    dbState.defaultEnvVars = {};
    dbState.defaultCliFlagsPerTool = {};
    dbState.launchSnapshots = {};
    dbState.saveCount = 0;
    safeStorageState.available = true;
    safeStorageState.decryptFails = false;
    profileState.profiles = [];
    helmHarness.capturedHandlers = null;
    helmHarness.setup.mockReset();
    helmHarness.setup.mockImplementation(async (_id: string, handlers: Record<string, (params: Record<string, unknown>) => Promise<unknown>>) => {
      helmHarness.capturedHandlers = handlers;
      return { mcpConfigPath: 'C:\\fake\\helm.json', cleanup: vi.fn() };
    });
    manager = new SessionManager();
  });

  afterEach(() => {
    manager.dispose();
  });

  it('captures only selected Codex launch metadata after inherited flags are disabled', async () => {
    dbState.defaultCliFlagsPerTool.codex = ['--model=old-model', '--profile=work'];
    const cliArgs = ['--model', 'new-model', '-c model_reasoning_effort=xhigh', '-c private_value=SECRET'];
    const session = await manager.createSession({
      workingDir: 'C:/projects/tether', cliTool: 'codex', cliArgs,
      disabledInheritedFlags: ['--model=old-model'],
    }, callbacks());
    expect(session.toInfo().codexLaunch).toEqual({ model: 'new-model', profile: 'work', reasoningEffort: 'xhigh' });
    expect(JSON.stringify(session.toInfo())).not.toContain('SECRET');
    expect(cliArgs).toEqual(['--model', 'new-model', '-c model_reasoning_effort=xhigh', '-c private_value=SECRET']);
  });

  it('stores launch overrides only in an opaque encrypted snapshot id', async () => {
    const session = await manager.createSession({
      workingDir: 'C:/projects/tether',
      cliTool: 'codex',
      env: { ARBITRARY_SECRET: 'plain-secret' },
      cliArgs: ['-c private_value=SECRET'],
      disabledInheritedFlags: ['--profile=old'],
    }, callbacks());
    const info = session.toInfo();
    expect(info.launchSnapshotId).toBeTruthy();
    expect(JSON.stringify(info)).not.toContain('plain-secret');
    expect(JSON.stringify(info)).not.toContain('private_value');
    expect(JSON.stringify(dbState.launchSnapshots)).not.toContain('plain-secret');
    expect(JSON.stringify(dbState.launchSnapshots)).not.toContain('private_value');
    expect(dbState.saveCount).toBe(1);
  });

  it('restores encrypted launch overrides while preserving caller metadata and native resume id', async () => {
    const original = await manager.createSession({
      workingDir: 'C:/projects/original',
      label: 'Original',
      cliTool: 'codex',
      env: { FEATURE_TOKEN: 'secret-token' },
      cliArgs: ['--model', 'gpt-5'],
      disabledInheritedFlags: ['--model=gpt-4'],
    }, callbacks());
    const restored = await manager.createSession({
      workingDir: 'C:/projects/new',
      label: 'Restored',
      cliTool: 'codex',
      launchSnapshotId: original.toInfo().launchSnapshotId,
      resumeToolSessionId: 'native-id',
    }, callbacks());
    const start = transportHarness.state.instances[1].start.mock.calls[0][0];
    expect(restored.toInfo()).toMatchObject({
      workingDir: 'C:/projects/new',
      label: 'Restored',
      launchSnapshotId: original.toInfo().launchSnapshotId,
    });
    expect(start.env.FEATURE_TOKEN).toBe('secret-token');
    expect(start.cliArgs).toEqual(['--model', 'gpt-5']);
    expect(start.resumeToolSessionId).toBeUndefined();
  });

  it('creates a new snapshot when callers override a saved launch intent', async () => {
    const original = await manager.createSession({
      workingDir: 'C:/projects/original',
      env: { TOKEN: 'old' },
      cliArgs: ['--model', 'old'],
    }, callbacks());
    const sourceId = original.toInfo().launchSnapshotId;
    const duplicate = await manager.createSession({
      workingDir: 'C:/projects/duplicate',
      launchSnapshotId: sourceId,
      env: { TOKEN: 'new' },
      cliArgs: ['--model', 'new'],
    }, callbacks());
    const start = transportHarness.state.instances[1].start.mock.calls[0][0];
    expect(duplicate.toInfo().launchSnapshotId).toBeTruthy();
    expect(duplicate.toInfo().launchSnapshotId).not.toBe(sourceId);
    expect(start.env.TOKEN).toBe('new');
    expect(start.cliArgs).toEqual(['--model', 'new']);
    expect(Object.keys(dbState.launchSnapshots)).toHaveLength(2);
  });

  it('drops the snapshot reference when callers explicitly clear all saved launch overrides', async () => {
    const original = await manager.createSession({
      workingDir: 'C:/projects/original',
      env: { TOKEN: 'old' },
      cliArgs: ['--model', 'old'],
      disabledInheritedFlags: ['--profile=old'],
    }, callbacks());
    const cleared = await manager.createSession({
      workingDir: 'C:/projects/cleared',
      launchSnapshotId: original.toInfo().launchSnapshotId,
      env: {},
      cliArgs: [],
      disabledInheritedFlags: [],
    }, callbacks());
    const start = transportHarness.state.instances[1].start.mock.calls[0][0];
    expect(cleared.toInfo().launchSnapshotId).toBeUndefined();
    expect(start.env.TOKEN).toBeUndefined();
    expect(start.cliArgs).toBeUndefined();
    expect(Object.keys(dbState.launchSnapshots)).toHaveLength(1);
  });

  it('fails before transport start when saved launch settings cannot be read', async () => {
    const original = await manager.createSession({
      workingDir: 'C:/projects/original',
      env: { TOKEN: 'secret' },
    }, callbacks());
    safeStorageState.available = false;
    await expect(manager.createSession({
      workingDir: 'C:/projects/restored',
      launchSnapshotId: original.toInfo().launchSnapshotId,
    }, callbacks())).rejects.toThrow(/could not be decrypted/);
    expect(transportHarness.state.instances).toHaveLength(1);
  });

  it('fails before transport start when a saved launch profile was deleted', async () => {
    profileState.profiles = [{ id: 'profile-1', name: 'Work', env_vars: '{}', cli_flags: '[]', cli_flags_per_tool: '{}' }];
    const original = await manager.createSession({
      workingDir: 'C:/projects/original',
      profileId: 'profile-1',
    }, callbacks());
    profileState.profiles = [];
    await expect(manager.createSession({
      workingDir: 'C:/projects/restored',
      launchSnapshotId: original.toInfo().launchSnapshotId,
    }, callbacks())).rejects.toThrow(/profile no longer exists/);
    expect(transportHarness.state.instances).toHaveLength(1);
  });

  it('does not require keychain or persist a snapshot for empty ordinary launches', async () => {
    safeStorageState.available = false;
    const session = await manager.createSession({
      workingDir: 'C:/projects/plain', env: {}, cliArgs: [], disabledInheritedFlags: [],
    }, callbacks());
    expect(session.toInfo().launchSnapshotId).toBeUndefined();
    expect(dbState.launchSnapshots).toEqual({});
    expect(transportHarness.state.instances[0].start).toHaveBeenCalledOnce();
  });

  it('does not persist a prepared launch snapshot when transport start fails', async () => {
    transportHarness.state.startImpl.mockRejectedValueOnce(new Error('launch failed'));
    await expect(manager.createSession({
      workingDir: 'C:/projects/fail',
      env: { TOKEN: 'secret' },
    }, callbacks())).rejects.toThrow('launch failed');
    expect(dbState.launchSnapshots).toEqual({});
    expect(dbState.saveCount).toBe(0);
  });

  it('does not replay cloneUrl or initialPrompt from a saved launch snapshot', async () => {
    const original = await manager.createSession({
      workingDir: 'C:/projects/original',
      env: { TOKEN: 'secret' },
      cloneUrl: 'https://example.test/repo.git',
      initialPrompt: 'one shot',
    }, callbacks());
    const restored = await manager.createSession({
      workingDir: 'C:/projects/restored',
      launchSnapshotId: original.toInfo().launchSnapshotId,
    }, callbacks());
    const start = transportHarness.state.instances[1].start.mock.calls[0][0];
    expect(restored.toInfo().launchSnapshotId).toBe(original.toInfo().launchSnapshotId);
    expect(start.env.TOKEN).toBe('secret');
    expect(start.cloneUrl).toBeUndefined();
    expect(start.initialPrompt).toBeUndefined();
  });

  it('Vault preflight sees refs inside rehydrated launch snapshots', async () => {
    const original = await manager.createSession({
      workingDir: 'C:/projects/original',
      env: { API_TOKEN: 'vault://secret/tether#token' },
    }, callbacks());
    await expect(findVaultRefInSession({
      workingDir: 'C:/projects/restored',
      launchSnapshotId: original.toInfo().launchSnapshotId,
    })).resolves.toBe('env var API_TOKEN');
  });

  it('combines restored launch settings with SSH native resume ids', async () => {
    envState.type = 'ssh';
    const original = await manager.createSession({
      environmentId: 'env',
      cliTool: 'codex',
      workingDir: '/work',
      env: { CODEX_HOME: '/custom/codex' },
    }, callbacks());
    const restored = await manager.createSession({
      environmentId: 'env',
      cliTool: 'codex',
      workingDir: '/work',
      launchSnapshotId: original.toInfo().launchSnapshotId,
      resumeToolSessionId: 'remote-native-id',
    }, callbacks());
    const start = transportHarness.state.instances[1].start.mock.calls[0][0];
    expect(start.env.CODEX_HOME).toBe('/custom/codex');
    expect(start.resumeToolSessionId).toBe('remote-native-id');
    expect(start.toolSessionId).toBe('remote-native-id');
    expect(restored.toInfo()).toMatchObject({ toolSessionId: 'remote-native-id', resumed: true });
  });

  it.each([
    ['ssh', 'claude'], ['ssh', 'codex'], ['coder', 'claude'], ['coder', 'codex'],
  ] as const)('collects %s/%s usage with hooks off and leaves terminal bytes unchanged', async (transport, cli) => {
    envState.type = transport;
    const cb = callbacks();
    const session = await manager.createSession({ environmentId: 'env', cliTool: cli,
      workingDir: transport === 'coder' ? 'workspace::/work' : '/work',
      env: { CODEX_HOME: '/custom/codex', CLAUDE_CONFIG_DIR: '/custom/claude' },
    }, cb);
    const start = transportHarness.state.instances[0].start.mock.calls[0][0];
    expect(start.env.TETHER_USAGE_SESSION_ID).toBe(session.id);
    expect(start.toolSessionId !== undefined).toBe(cli === 'claude');
    expect(remoteUsageService.start).toHaveBeenCalledOnce();
    const options = vi.mocked(remoteUsageService.start).mock.calls[0][0];
    expect(options).toMatchObject({ cli, workingDir: '/work', workspace: transport === 'coder' ? 'workspace' : '',
      claudeHome: '/custom/claude', codexHome: '/custom/codex' });
    options.onSource('remote:scoped-id', 'actual-native-id');
    expect(session.toInfo().usageSessionId).toBe('remote:scoped-id');
    expect(session.toolSessionId).toBe('actual-native-id');
    const raw = '\x1b[31mraw\r\n\x1b[0m';
    transportHarness.state.instances[0].onData.mock.calls[0][0](raw);
    expect(cb.onData).toHaveBeenLastCalledWith(session.id, raw);
    transportHarness.state.instances[0].onExit.mock.calls[0][0]({ exitCode: 0 });
    expect(remoteUsageService.stop).toHaveBeenCalledWith(session.id);
  });

  it('does not start collection when a remote CLI launch fails', async () => {
    envState.type = 'ssh';
    transportHarness.state.startImpl.mockRejectedValueOnce(new Error('launch failed'));
    await expect(manager.createSession({ environmentId: 'env', cliTool: 'codex', workingDir: '/work' }, callbacks())).rejects.toThrow('launch failed');
    expect(remoteUsageService.start).not.toHaveBeenCalled();
  });

  it.each(['claude', 'codex'] as const)('keeps a starting SSH %s duplicate alive when the original is removed', async cliTool => {
    envState.type = 'ssh';
    const opts = { environmentId: 'env', cliTool, workingDir: '/work' };
    const original = await manager.createSession(opts, callbacks());
    let connected!: () => void;
    transportHarness.state.startImpl.mockImplementationOnce(() => new Promise<void>(resolve => { connected = resolve; }));
    const cb = callbacks();
    const creation = manager.createSession({ ...opts, label: 'work (copy)' }, cb);
    await vi.waitFor(() => expect(transportHarness.state.instances[1]?.start).toHaveBeenCalled());

    manager.removeSession(original.id);
    expect(transportHarness.state.instances[0].dispose).toHaveBeenCalledOnce();
    expect(transportHarness.state.instances[1].dispose).not.toHaveBeenCalled();
    connected();
    const duplicate = await creation;
    expect(manager.getSession(original.id)).toBeUndefined();
    expect(manager.getSession(duplicate.id)).toBe(duplicate);
    expect(duplicate.transport).not.toBeNull();
    const raw = '\x1b[32mduplicate ready\x1b[0m\r\n';
    transportHarness.state.instances[1].onData.mock.calls[0][0](raw);
    expect(cb.onData).toHaveBeenCalledWith(duplicate.id, raw);
  });

  it.each([
    ['ssh', 'claude'], ['ssh', 'codex'], ['coder', 'claude'], ['coder', 'codex'],
  ] as const)('resumes the exact %s/%s conversation after disconnect, with hooks off', async (transport, cli) => {
    envState.type = transport;
    const workingDir = transport === 'coder' ? 'workspace::/work' : '/work';
    const original = await manager.createSession({ environmentId: 'env', cliTool: cli, workingDir }, callbacks());
    const nativeId = cli === 'claude' ? original.toolSessionId! : '019a0000-0000-7000-8000-000000000001';
    vi.mocked(remoteUsageService.start).mock.calls[0][0].onSource('remote:original', nativeId);
    transportHarness.state.instances[0].onExit.mock.calls[0][0]({ exitCode: 1 });

    // Another conversation in the same directory must not affect recovery.
    await manager.createSession({ environmentId: 'env', cliTool: cli, workingDir }, callbacks());
    const restarted = await manager.createSession(buildSessionRestartOptions(original.toInfo()), callbacks());
    const start = transportHarness.state.instances[2].start.mock.calls[0][0];
    expect(restarted.id).not.toBe(original.id);
    expect(start.resumeToolSessionId).toBe(nativeId);
    expect(start.toolSessionId).toBe(nativeId);
    expect(start.resumeClaudeSessionId).toBe(cli === 'claude' ? nativeId : undefined);
    expect(restarted.toInfo()).toMatchObject({ toolSessionId: nativeId, resumed: true });
    expect(vi.mocked(remoteUsageService.start).mock.calls[2][0].nativeSessionId).toBe(nativeId);
  });

  it.each(['ssh', 'coder'] as const)('restores a legacy Claude conversation id on %s', async transport => {
    envState.type = transport;
    const nativeId = '019a0000-0000-7000-8000-000000000002';
    const session = await manager.createSession({ environmentId: 'env', workingDir: '/work',
      resumeClaudeSessionId: nativeId }, callbacks());
    expect(transportHarness.state.instances[0].start.mock.calls[0][0].resumeToolSessionId).toBe(nativeId);
    expect(session.toInfo()).toMatchObject({ claudeSessionId: nativeId, toolSessionId: nativeId, resumed: true });
  });

  describe('spawn_session helm handler — cliTool', () => {
    async function spawnHelmParent(): Promise<Record<string, (params: Record<string, unknown>) => Promise<unknown>>> {
      dbState.config.allowHelm = 'true';
      // Register a child-callbacks shim — the spawn_session handler refuses to
      // run children otherwise.
      setHelmChildCallbacks({
        onData: vi.fn(),
        onStateChange: vi.fn(),
        onExit: vi.fn(),
      });
      const cb = callbacks();
      await manager.createSession({
        workingDir: 'C:\\repo\\helm-parent',
        cliTool: 'claude',
        helmEnabled: true,
      }, cb);
      if (!helmHarness.capturedHandlers) {
        throw new Error('Helm setup was not invoked — fixture is wrong');
      }
      return helmHarness.capturedHandlers;
    }

    it('rejects an unknown cliTool with a clear error', async () => {
      const handlers = await spawnHelmParent();
      await expect(
        handlers.spawn_session({
          environmentId: 'env-1',
          label: 'child',
          initialPrompt: 'hi',
          cliTool: 'gpt-cli', // not in the registry
        }),
      ).rejects.toThrow(/unknown cliTool "gpt-cli"/);
      // Validation must happen BEFORE any session is created.
      expect(manager.listSessions()).toHaveLength(1); // only the parent
    });

    it('rejects a non-string cliTool', async () => {
      const handlers = await spawnHelmParent();
      await expect(
        handlers.spawn_session({
          environmentId: 'env-1',
          label: 'child',
          initialPrompt: 'hi',
          cliTool: 42,
        }),
      ).rejects.toThrow(/cliTool must be a string/);
    });

    it('accepts a valid cliTool and dispatches the child on that CLI', async () => {
      const handlers = await spawnHelmParent();
      const result = await handlers.spawn_session({
        environmentId: 'env-1',
        label: 'child',
        initialPrompt: 'hi',
        cliTool: 'codex',
      }) as { sessionId: string };
      const child = manager.getSession(result.sessionId);
      expect(child?.cliTool).toBe('codex');
    });

    it('inherits the parent cliTool when omitted', async () => {
      const handlers = await spawnHelmParent();
      const result = await handlers.spawn_session({
        environmentId: 'env-1',
        label: 'child',
        initialPrompt: 'hi',
        // no cliTool → inherit parent ('claude')
      }) as { sessionId: string };
      const child = manager.getSession(result.sessionId);
      expect(child?.cliTool).toBe('claude');
    });
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

  describe('Claude status hook handling', () => {
    async function createClaudeSession() {
      const cb = callbacks();
      const session = await manager.createSession({ workingDir: 'C:/repo/claude-hooks', cliTool: 'claude' }, cb);
      statusDetector.setHookCapable(session.id, true);
      return { session, cb };
    }

    it.each(['tool_start', 'tool_complete', 'elicitation_complete', 'elicitation_response'] as const)(
      'resumes work after %s rather than declaring the turn complete', async (type) => {
        const { session, cb } = await createClaudeSession();
        manager.handleHookEvent({ tetherSessionId: session.id, source: 'claude', type: 'permission_prompt' });
        expect(session.waitingReason).toBe('permission');
        manager.handleHookEvent({ tetherSessionId: session.id, source: 'claude', type });
        expect(cb.onStateChange).toHaveBeenLastCalledWith(session.id, 'running', undefined);
      },
    );

    it('tracks parent completion separately from multiple subagent completions', async () => {
      const { session } = await createClaudeSession();
      const event = (type: 'subagent_start' | 'subagent_stop', agentId: string) => manager.handleHookEvent({
        tetherSessionId: session.id, source: 'claude', type, payload: { agent_id: agentId },
      });
      event('subagent_start', 'agent-a');
      event('subagent_start', 'agent-b');
      manager.handleHookEvent({ tetherSessionId: session.id, source: 'claude', type: 'turn_complete' });
      expect(session.state).toBe('running');
      event('subagent_stop', 'agent-a');
      expect(session.state).toBe('running');
      event('subagent_stop', 'agent-b');
      expect(session.state).toBe('waiting');
      expect(session.waitingReason).toBe('idle');
    });

    it('keeps hook completion through raw transport output without modifying the stream', async () => {
      vi.useFakeTimers();
      try {
        const { session, cb } = await createClaudeSession();
        manager.handleHookEvent({ tetherSessionId: session.id, source: 'claude', type: 'turn_complete' });
        const transport = transportHarness.state.instances.at(-1)!;
        const raw = '\x1b[2Jfinal flush\x07prompt';
        (transport.onData.mock.calls[0][0] as (data: string) => void)(raw);
        vi.advanceTimersByTime(31_000);
        expect(session.waitingReason).toBe('idle');
        expect(cb.onData).toHaveBeenCalledWith(session.id, raw);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps parent completion pending through inherited subagent tool hooks', async () => {
      const { session } = await createClaudeSession();
      manager.handleHookEvent({
        tetherSessionId: session.id, source: 'claude', type: 'subagent_start', payload: { agent_id: 'agent-a' },
      });
      manager.handleHookEvent({ tetherSessionId: session.id, source: 'claude', type: 'turn_complete' });
      for (const type of ['tool_start', 'tool_complete', 'idle_prompt'] as const) {
        manager.handleHookEvent({
          tetherSessionId: session.id, source: 'claude', type, payload: { agent_id: 'agent-a' },
        });
        expect(session.state).toBe('running');
      }
      manager.handleHookEvent({
        tetherSessionId: session.id, source: 'claude', type: 'subagent_stop', payload: { agent_id: 'agent-a' },
      });
      expect(session.waitingReason).toBe('idle');
    });

    it('does not treat a subagent Stop as completion of its still-running parent', async () => {
      const { session } = await createClaudeSession();
      manager.handleHookEvent({
        tetherSessionId: session.id, source: 'claude', type: 'subagent_start', payload: { agent_id: 'agent-a' },
      });
      manager.handleHookEvent({
        tetherSessionId: session.id, source: 'claude', type: 'turn_complete', payload: { agent_id: 'agent-a' },
      });
      expect(session.state).toBe('running');
    });

    it('rejects another Claude native session and Claude events sent to Codex sessions', async () => {
      const { session, cb } = await createClaudeSession();
      session.toolSessionId = 'claude-parent';
      cb.onStateChange.mockClear();
      manager.handleHookEvent({
        tetherSessionId: session.id, source: 'claude', type: 'turn_complete', payload: { session_id: 'other-session' },
      });
      expect(cb.onStateChange).not.toHaveBeenCalled();
      const codex = await manager.createSession({ workingDir: 'C:/repo/codex-hooks', cliTool: 'codex' }, cb);
      cb.onStateChange.mockClear();
      manager.handleHookEvent({ tetherSessionId: codex.id, source: 'claude', type: 'turn_complete' });
      expect(cb.onStateChange).not.toHaveBeenCalled();
    });
  });

  describe('Codex lifecycle hook handling', () => {
    async function createCodexSession() {
      const cb = callbacks();
      const session = await manager.createSession({
        workingDir: 'C:\\repo\\codex-hooks',
        cliTool: 'codex',
      }, cb);
      session.toolSessionId = 'native-codex-1';
      cb.onStateChange.mockClear();
      cb.onUpdate.mockClear();
      return { session, cb };
    }

    it('treats Codex SessionStart as a ready prompt until a turn starts', async () => {
      const { session } = await createCodexSession();
      manager.handleHookEvent({
        tetherSessionId: session.id, source: 'codex', type: 'session_start',
        payload: { toolSessionId: 'native-codex-1' },
      });
      expect(session.waitingReason).toBe('idle');
      manager.handleHookEvent({
        tetherSessionId: session.id, source: 'codex', type: 'turn_start',
        payload: { toolSessionId: 'native-codex-1', turnId: 'turn-1' },
      });
      expect(session.state).toBe('running');
    });

    it('rejects a wrong native Codex session id before status mutation', async () => {
      const { session, cb } = await createCodexSession();

      manager.handleHookEvent({
        tetherSessionId: session.id,
        source: 'codex',
        type: 'permission_prompt',
        payload: {
          toolSessionId: 'someone-else',
          at: '2026-09-07T00:00:01.000Z',
        },
      });

      expect(session.activity).toBeNull();
      expect(cb.onUpdate).not.toHaveBeenCalled();
      expect(cb.onStateChange).not.toHaveBeenCalled();
    });

    it('rejects Codex lifecycle events for non-Codex sessions before status mutation', async () => {
      const cb = callbacks();
      const session = await manager.createSession({
        workingDir: 'C:\\repo\\claude-hooks',
        cliTool: 'claude',
      }, cb);
      cb.onStateChange.mockClear();
      cb.onUpdate.mockClear();

      manager.handleHookEvent({
        tetherSessionId: session.id,
        source: 'codex',
        type: 'permission_prompt',
        payload: {
          toolSessionId: 'native-codex-1',
          at: '2026-09-07T00:00:01.000Z',
        },
      });

      expect(session.activity).toBeNull();
      expect(cb.onUpdate).not.toHaveBeenCalled();
      expect(cb.onStateChange).not.toHaveBeenCalled();
    });

    it('rejects stale Codex lifecycle events before status mutation', async () => {
      const { session, cb } = await createCodexSession();

      manager.handleHookEvent({
        tetherSessionId: session.id,
        source: 'codex',
        type: 'turn_start',
        payload: {
          toolSessionId: 'native-codex-1',
          at: '2026-09-07T00:00:02.000Z',
        },
      });
      cb.onStateChange.mockClear();
      cb.onUpdate.mockClear();

      manager.handleHookEvent({
        tetherSessionId: session.id,
        source: 'codex',
        type: 'permission_prompt',
        payload: {
          toolSessionId: 'native-codex-1',
          at: '2026-09-07T00:00:01.000Z',
        },
      });

      expect(session.activity?.phase).toBe('running');
      expect(cb.onUpdate).not.toHaveBeenCalled();
      expect(cb.onStateChange).not.toHaveBeenCalled();
    });

    it('rejects older turn permission and stop events after a newer turn starts', async () => {
      const { session, cb } = await createCodexSession();

      manager.handleHookEvent({
        tetherSessionId: session.id,
        source: 'codex',
        type: 'turn_start',
        payload: {
          toolSessionId: 'native-codex-1',
          turnId: 'turn-old',
          at: '2026-09-07T00:00:01.000Z',
        },
      });
      manager.handleHookEvent({
        tetherSessionId: session.id,
        source: 'codex',
        type: 'turn_start',
        payload: {
          toolSessionId: 'native-codex-1',
          turnId: 'turn-new',
          at: '2026-09-07T00:00:02.000Z',
        },
      });
      cb.onStateChange.mockClear();
      cb.onUpdate.mockClear();

      manager.handleHookEvent({
        tetherSessionId: session.id,
        source: 'codex',
        type: 'permission_prompt',
        payload: {
          toolSessionId: 'native-codex-1',
          turnId: 'turn-old',
          at: '2026-09-07T00:00:03.000Z',
        },
      });
      manager.handleHookEvent({
        tetherSessionId: session.id,
        source: 'codex',
        type: 'turn_complete',
        payload: {
          toolSessionId: 'native-codex-1',
          turnId: 'turn-old',
          at: '2026-09-07T00:00:04.000Z',
        },
      });

      expect(session.activity?.currentTurnId).toBe('turn-new');
      expect(session.activity?.phase).toBe('running');
      expect(cb.onUpdate).not.toHaveBeenCalled();
      expect(cb.onStateChange).not.toHaveBeenCalled();
    });

    it('clears a resolved permission wait when Codex reports tool completion', async () => {
      const { session, cb } = await createCodexSession();

      manager.handleHookEvent({
        tetherSessionId: session.id,
        source: 'codex',
        type: 'permission_prompt',
        payload: {
          toolSessionId: 'native-codex-1',
          turnId: 'turn-1',
          at: '2026-09-07T00:00:01.000Z',
        },
      });
      expect(cb.onStateChange).toHaveBeenLastCalledWith(session.id, 'waiting', 'permission');
      cb.onStateChange.mockClear();

      manager.handleHookEvent({
        tetherSessionId: session.id,
        source: 'codex',
        type: 'tool_complete',
        payload: {
          toolSessionId: 'native-codex-1',
          turnId: 'turn-1',
          at: '2026-09-07T00:00:02.000Z',
        },
      });

      expect(session.activity?.phase).toBe('running');
      expect(cb.onStateChange).toHaveBeenCalledWith(session.id, 'running', undefined);
    });

    it.each(['turn_interrupted', 'session_end'] as const)(
      'maps accepted Codex %s events to waiting idle status',
      async (type) => {
        const { session, cb } = await createCodexSession();

        manager.handleHookEvent({
          tetherSessionId: session.id,
          source: 'codex',
          type: 'turn_start',
          payload: {
            toolSessionId: 'native-codex-1',
            turnId: 'turn-1',
            at: '2026-09-07T00:00:01.000Z',
          },
        });
        cb.onStateChange.mockClear();

        manager.handleHookEvent({
          tetherSessionId: session.id,
          source: 'codex',
          type,
          payload: {
            toolSessionId: 'native-codex-1',
            turnId: 'turn-1',
            at: '2026-09-07T00:00:02.000Z',
          },
        });

        expect(cb.onStateChange).toHaveBeenCalledWith(session.id, 'waiting', 'idle');
      },
    );

    it('clears activity before exit state observers run', async () => {
      const { session } = await createCodexSession();
      manager.handleHookEvent({
        tetherSessionId: session.id,
        source: 'codex',
        type: 'turn_start',
        payload: {
          toolSessionId: 'native-codex-1',
          turnId: 'turn-1',
          at: '2026-09-07T00:00:01.000Z',
        },
      });
      expect(session.activity).not.toBeNull();
      const observedActivity: Array<unknown> = [];
      manager.addLifecycleObserver({
        onStateChanged: (changed) => observedActivity.push(changed.activity),
      });

      const transport = transportHarness.state.instances[transportHarness.state.instances.length - 1];
      const exitHandler = transport?.onExit.mock.calls[0][0] as (info: TransportExitInfo) => void;
      exitHandler({ exitCode: 0 });

      expect(observedActivity).toEqual([null]);
    });

    it('keeps the legacy handleHookEvent(id, type) call shape working', async () => {
      const cb = callbacks();
      const session = await manager.createSession({
        workingDir: 'C:\\repo\\legacy-hooks',
        cliTool: 'claude',
      }, cb);
      cb.onStateChange.mockClear();

      manager.handleHookEvent(session.id, 'permission_prompt');

      expect(cb.onStateChange).toHaveBeenCalledWith(session.id, 'waiting', 'permission');
    });
  });

  describe('forceKill', () => {
    async function createHelmSession(cb: ReturnType<typeof callbacks>) {
      dbState.config.allowHelm = 'true';
      const helmCleanup = vi.fn();
      helmHarness.setup.mockImplementation(async () => ({
        mcpConfigPath: 'C:\\fake\\helm.json',
        cleanup: helmCleanup,
      }));
      await manager.createSession({
        workingDir: 'C:\\repo\\victim',
        cliTool: 'claude',
        helmEnabled: true,
      }, cb);
      return { id: manager.listSessions()[0].id, helmCleanup };
    }

    it('runs exit cleanup itself when the transport exits asynchronously', async () => {
      const cb = callbacks();
      const { id, helmCleanup } = await createHelmSession(cb);
      const transport = transportHarness.state.instances[0];

      manager.forceKill(id);

      expect(transport.kill).toHaveBeenCalled();
      expect(helmCleanup).toHaveBeenCalledTimes(1);
      expect(cb.onExit).toHaveBeenCalledTimes(1);
      expect(cb.onExit).toHaveBeenCalledWith(id, { exitCode: 1 });

      // The PTY's real exit lands later: the transport's onExit handler fires
      // after forceKill already nulled the transport. It must not double-fire
      // the exit event or the helm cleanup.
      const exitHandler = transport.onExit.mock.calls[0][0] as (info: TransportExitInfo) => void;
      exitHandler({ exitCode: 1 });

      expect(cb.onExit).toHaveBeenCalledTimes(1);
      expect(helmCleanup).toHaveBeenCalledTimes(1);
    });

    it('defers to the exit handler when kill() fires onExit synchronously', async () => {
      const cb = callbacks();
      const { id, helmCleanup } = await createHelmSession(cb);
      const transport = transportHarness.state.instances[0];
      const exitHandler = transport.onExit.mock.calls[0][0] as (info: TransportExitInfo) => void;
      transport.kill.mockImplementation(() => exitHandler({ exitCode: 0 }));

      manager.forceKill(id);

      // The synchronous onExit ran the normal cleanup path; forceKill must not
      // repeat it with its own exitCode.
      expect(cb.onExit).toHaveBeenCalledTimes(1);
      expect(cb.onExit).toHaveBeenCalledWith(id, { exitCode: 0, signal: undefined });
      expect(helmCleanup).toHaveBeenCalledTimes(1);
    });
  });
});
