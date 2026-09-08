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

const dbState = vi.hoisted(() => ({
  config: {} as Record<string, string>,
  defaultEnvVars: {} as Record<string, string>,
  defaultCliFlagsPerTool: {} as Record<string, string[]>,
}));

vi.mock('../db/database', () => ({
  getDb: () => dbState,
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

vi.mock('../coder/workspace-service', () => ({
  createCoderWorkspace: vi.fn(),
  listCoderWorkspaces: vi.fn(),
  listCoderTemplates: vi.fn(),
  getCoderTemplateParams: vi.fn(),
}));

import { SessionManager, setHelmChildCallbacks } from './session-manager';

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
    dbState.config = {};
    dbState.defaultEnvVars = {};
    dbState.defaultCliFlagsPerTool = {};
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
