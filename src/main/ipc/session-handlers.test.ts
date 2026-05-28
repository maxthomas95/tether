import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHarness, makeElectronMockBase, type IpcRegistry } from './ipc-test-harness.test-helper';

const registry = vi.hoisted<IpcRegistry>(() => ({ handlers: new Map(), listeners: new Map() }));
vi.mock('electron', () => makeElectronMockBase(registry));

const sessionManagerMock = vi.hoisted(() => ({
  createSession: vi.fn(),
  listSessions: vi.fn().mockReturnValue([]),
  stopSession: vi.fn(),
  renameSession: vi.fn(),
  setHelmEnabled: vi.fn(),
  removeSession: vi.fn(),
  writeToSession: vi.fn(),
  resizeSession: vi.fn(),
  getSession: vi.fn(),
}));
const sessionExtras = vi.hoisted(() => ({
  findVaultRefInSession: vi.fn(),
  setHelmChildCallbacks: vi.fn(),
}));
vi.mock('../session/session-manager', () => ({
  sessionManager: sessionManagerMock,
  ...sessionExtras,
}));

const sessionRepoMocks = vi.hoisted(() => ({
  createSessionRow: vi.fn(),
  updateSessionLabel: vi.fn(),
  updateSessionState: vi.fn(),
}));
vi.mock('../db/session-repo', () => sessionRepoMocks);

const usageServiceMock = vi.hoisted(() => ({
  trackSession: vi.fn(),
  untrackSession: vi.fn(),
}));
vi.mock('../usage/usage-service', () => ({ usageService: usageServiceMock }));

const vaultAuthMock = vi.hoisted(() => ({ getStatus: vi.fn() }));
vi.mock('../vault/vault-auth', () => vaultAuthMock);

const dbState = vi.hoisted(() => ({ savedWorkspace: null as unknown, saveCount: 0 }));
vi.mock('../db/database', () => ({
  getDb: () => dbState,
  saveDb: () => { dbState.saveCount += 1; },
}));

const transcriptMocks = vi.hoisted(() => ({
  listTranscripts: vi.fn().mockResolvedValue([]),
  listCodexTranscripts: vi.fn().mockResolvedValue([]),
  listCopilotTranscripts: vi.fn().mockResolvedValue([]),
  listOpencodeTranscripts: vi.fn().mockResolvedValue([]),
}));
vi.mock('../claude/transcripts', () => ({ listTranscripts: transcriptMocks.listTranscripts }));
vi.mock('../codex/transcripts', () => ({ listCodexTranscripts: transcriptMocks.listCodexTranscripts }));
vi.mock('../copilot/transcripts', () => ({ listCopilotTranscripts: transcriptMocks.listCopilotTranscripts }));
vi.mock('../opencode/transcripts', () => ({ listOpencodeTranscripts: transcriptMocks.listOpencodeTranscripts }));

import { IPC } from '../../shared/constants';
import { registerSessionHandlers } from './session-handlers';

const harness = createHarness(registry);

const fakeSession = (overrides: Record<string, unknown> = {}) => ({
  id: 's1',
  label: 'session',
  workingDir: '/repo',
  claudeSessionId: undefined as string | undefined,
  cliTool: 'claude' as string,
  toolSessionId: undefined as string | undefined,
  toInfo: () => ({ id: 's1', label: 'session', workingDir: '/repo' }),
  ...overrides,
});

describe('session-handlers', () => {
  beforeEach(() => {
    harness.reset();
    Object.values(sessionManagerMock).forEach((m) => 'mockReset' in m && m.mockReset());
    Object.values(sessionExtras).forEach((m) => m.mockReset());
    Object.values(sessionRepoMocks).forEach((m) => m.mockReset());
    Object.values(usageServiceMock).forEach((m) => m.mockReset());
    vaultAuthMock.getStatus.mockReset();
    dbState.savedWorkspace = null;
    dbState.saveCount = 0;
    sessionManagerMock.listSessions.mockReturnValue([]);
    registerSessionHandlers(harness.ctx);
  });

  it('registers a Helm child-callback bundle once', () => {
    expect(sessionExtras.setHelmChildCallbacks).toHaveBeenCalledTimes(1);
  });

  describe('SESSION_CREATE', () => {
    it('creates session, persists row, returns toInfo()', async () => {
      const s = fakeSession();
      sessionManagerMock.createSession.mockResolvedValue(s);
      const opts = { workingDir: '/repo', environmentId: 'env-1' };
      const result = await harness.invoke<{ id: string }>(IPC.SESSION_CREATE, opts);
      expect(sessionManagerMock.createSession).toHaveBeenCalledWith(opts, expect.any(Object));
      expect(sessionRepoMocks.createSessionRow).toHaveBeenCalledWith(expect.objectContaining({
        label: 'session',
        working_dir: '/repo',
        environment_id: 'env-1',
        state: 'running',
      }));
      expect(result).toEqual({ id: 's1', label: 'session', workingDir: '/repo' });
    });

    it('tracks Claude usage when claudeSessionId is set, with environmentId', async () => {
      sessionManagerMock.createSession.mockResolvedValue(fakeSession({ claudeSessionId: 'claude-uuid', environmentId: 'env-1' }));
      await harness.invoke(IPC.SESSION_CREATE, { workingDir: '/repo', environmentId: 'env-1' });
      expect(usageServiceMock.trackSession).toHaveBeenCalledWith('claude-uuid', '/repo', 'claude', 'env-1');
    });

    it('tracks OpenCode usage when cliTool=opencode + toolSessionId set', async () => {
      sessionManagerMock.createSession.mockResolvedValue(fakeSession({ cliTool: 'opencode', toolSessionId: 'oc-id' }));
      await harness.invoke(IPC.SESSION_CREATE, { workingDir: '/repo', cliTool: 'opencode' });
      expect(usageServiceMock.trackSession).toHaveBeenCalledWith('oc-id', '/repo', 'opencode', undefined);
    });
  });

  describe('SESSION_VAULT_PREFLIGHT', () => {
    it('returns needsLogin:false when vault is disabled', async () => {
      vaultAuthMock.getStatus.mockReturnValue({ enabled: false, loggedIn: false });
      const result = await harness.invoke(IPC.SESSION_VAULT_PREFLIGHT, { workingDir: '/r' });
      expect(result).toEqual({ needsLogin: false });
    });

    it('returns needsLogin:false when already logged in', async () => {
      vaultAuthMock.getStatus.mockReturnValue({ enabled: true, loggedIn: true });
      const result = await harness.invoke(IPC.SESSION_VAULT_PREFLIGHT, { workingDir: '/r' });
      expect(result).toEqual({ needsLogin: false });
    });

    it('returns needsLogin:false when no vault refs found in the session', async () => {
      vaultAuthMock.getStatus.mockReturnValue({ enabled: true, loggedIn: false });
      sessionExtras.findVaultRefInSession.mockResolvedValue(null);
      const result = await harness.invoke(IPC.SESSION_VAULT_PREFLIGHT, { workingDir: '/r' });
      expect(result).toEqual({ needsLogin: false });
    });

    it('returns needsLogin:true with the source reason when refs are found', async () => {
      vaultAuthMock.getStatus.mockReturnValue({ enabled: true, loggedIn: false });
      sessionExtras.findVaultRefInSession.mockResolvedValue('env var ANTHROPIC_API_KEY');
      const result = await harness.invoke(IPC.SESSION_VAULT_PREFLIGHT, { workingDir: '/r' });
      expect(result).toEqual({ needsLogin: true, reason: 'env var ANTHROPIC_API_KEY' });
    });
  });

  it('SESSION_LIST returns toInfo() for each session', async () => {
    sessionManagerMock.listSessions.mockReturnValue([fakeSession({ id: 's1' }), fakeSession({ id: 's2' })]);
    const result = await harness.invoke(IPC.SESSION_LIST);
    expect(result).toEqual([
      { id: 's1', label: 'session', workingDir: '/repo' },
      { id: 's1', label: 'session', workingDir: '/repo' },
    ]);
  });

  it('SESSION_STOP / REMOVE / SET_HELM forward sessionId to manager', async () => {
    await harness.invoke(IPC.SESSION_STOP, 's1');
    expect(sessionManagerMock.stopSession).toHaveBeenCalledWith('s1');

    await harness.invoke(IPC.SESSION_REMOVE, 's3');
    expect(sessionManagerMock.removeSession).toHaveBeenCalledWith('s3');

    await harness.invoke(IPC.SESSION_SET_HELM_ENABLED, 's4', true);
    expect(sessionManagerMock.setHelmEnabled).toHaveBeenCalledWith('s4', true);
  });

  it('SESSION_RENAME updates manager AND repo', async () => {
    await harness.invoke(IPC.SESSION_RENAME, 's1', 'New Name');
    expect(sessionManagerMock.renameSession).toHaveBeenCalledWith('s1', 'New Name');
    expect(sessionRepoMocks.updateSessionLabel).toHaveBeenCalledWith('s1', 'New Name');
  });

  it('SESSION_INPUT / SESSION_RESIZE forward via emit', () => {
    harness.emit(IPC.SESSION_INPUT, 's1', 'hello');
    expect(sessionManagerMock.writeToSession).toHaveBeenCalledWith('s1', 'hello');

    harness.emit(IPC.SESSION_RESIZE, 's1', 100, 30);
    expect(sessionManagerMock.resizeSession).toHaveBeenCalledWith('s1', 100, 30);
  });

  describe('workspace save/load', () => {
    it('WORKSPACE_SAVE persists into db.savedWorkspace', async () => {
      const sessions = [{ workingDir: '/r', label: 'a' }];
      await harness.invoke(IPC.WORKSPACE_SAVE, sessions, 0);
      expect(dbState.savedWorkspace).toEqual({ sessions, activeIndex: 0 });
      expect(dbState.saveCount).toBe(1);
    });

    it('WORKSPACE_LOAD returns the stored workspace', async () => {
      dbState.savedWorkspace = { sessions: [], activeIndex: -1 };
      expect(await harness.invoke(IPC.WORKSPACE_LOAD)).toEqual({ sessions: [], activeIndex: -1 });
    });
  });

  describe('TRANSCRIPTS_LIST', () => {
    it('claude (default) routes to listTranscripts', async () => {
      await harness.invoke(IPC.TRANSCRIPTS_LIST, '/r');
      expect(transcriptMocks.listTranscripts).toHaveBeenCalledWith('/r');
    });

    it('codex routes to listCodexTranscripts', async () => {
      await harness.invoke(IPC.TRANSCRIPTS_LIST, '/r', 'codex');
      expect(transcriptMocks.listCodexTranscripts).toHaveBeenCalledWith('/r');
    });

    it('copilot routes to listCopilotTranscripts', async () => {
      await harness.invoke(IPC.TRANSCRIPTS_LIST, '/r', 'copilot');
      expect(transcriptMocks.listCopilotTranscripts).toHaveBeenCalledWith('/r');
    });

    it('opencode routes to listOpencodeTranscripts', async () => {
      await harness.invoke(IPC.TRANSCRIPTS_LIST, '/r', 'opencode');
      expect(transcriptMocks.listOpencodeTranscripts).toHaveBeenCalledWith('/r');
    });
  });
});
