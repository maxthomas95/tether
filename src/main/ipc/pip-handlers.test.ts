import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  config: {} as Record<string, string>, generate: vi.fn(), claude: vi.fn(), status: vi.fn(), prompt: vi.fn(), session: vi.fn(), environment: vi.fn(), transcript: vi.fn(),
  visible: true, minimized: false,
}));
vi.mock('electron', () => ({ app: { getPath: () => '/neutral' }, ipcMain: { handle: (key: string, fn: never) => mocks.handlers.set(key, fn) } }));
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn() }));
vi.mock('../db/database', () => ({ getDb: () => ({ config: mocks.config }) }));
vi.mock('../pip/backends', () => ({
  pipBackend: (id: string) => ({ id, generate: id === 'claude' ? mocks.claude : mocks.generate, status: (cwd: string, signal: AbortSignal) => mocks.status(id, cwd, signal) }),
}));
vi.mock('../pip/prompt-context', () => ({ readRecentPrompt: mocks.prompt }));
vi.mock('../session/session-manager', () => ({ sessionManager: { getSession: mocks.session } }));
vi.mock('../db/environment-repo', () => ({ getEnvironment: mocks.environment }));
vi.mock('../usage/usage-service', () => ({ usageService: { getLocalTranscriptPath: mocks.transcript } }));
import { registerPipHandlers, validatePipBackend, validatePipRequest } from './pip-handlers';
import { DEFAULT_PIP_SETTINGS, PIP_SETTINGS_KEY } from '../../shared/pip';
import { IPC } from '../../shared/constants';

const frame = {};
const webContents = { mainFrame: frame, on: vi.fn() };
const trusted = { sender: webContents, senderFrame: frame };
const win = { webContents, isDestroyed: () => false, isVisible: () => mocks.visible, isMinimized: () => mocks.minimized, on: vi.fn() } as unknown as BrowserWindow;
const request = { event: 'submitted', sessionId: 'a' };
function prefs(patch: Record<string, unknown> = {}) { mocks.config[PIP_SETTINGS_KEY] = JSON.stringify({ ...DEFAULT_PIP_SETTINGS, enabled: true, aiComments: true, ...patch }); }

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config = {}; mocks.visible = true; mocks.minimized = false;
  mocks.generate.mockResolvedValue({ status: 'ready', line: 'Quip.', model: 'gpt-6-luna', reason: null });
  mocks.session.mockReturnValue({ environmentId: 'local', cliTool: 'codex', toolSessionId: 'native-id' });
  mocks.environment.mockReturnValue({ type: 'local' });
  mocks.transcript.mockReturnValue('/attributed/rollout.jsonl');
  mocks.prompt.mockResolvedValue('Submitted idea');
  registerPipHandlers({ mainWindow: win, send: vi.fn() });
});

describe('Pip consent and IPC boundary', () => {
  it('rejects foreign frames, arbitrary text, and renderer-selected paths', async () => {
    const handler = mocks.handlers.get(IPC.PIP_COMMENT)!;
    expect(() => handler({ sender: {}, senderFrame: frame }, request)).toThrow('Tether window');
    expect(() => handler({ sender: webContents, senderFrame: {} }, request)).toThrow('Tether window');
    for (const raw of [null, { ...request, prompt: 'private' }, { ...request, cwd: '/elsewhere' }, { ...request, event: 'shell' }]) {
      expect(() => validatePipRequest(raw)).toThrow('Invalid');
    }
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(validatePipRequest({ event: 'longTurn', sessionId: 'a' }).event).toBe('longTurn');
    for (const event of ['crashed', 'delegated', 'quotaHigh']) expect(() => validatePipRequest({ ...request, event })).toThrow('Invalid');
  });
  it('does not read prompts or generate until AI is explicitly enabled', async () => {
    await mocks.handlers.get(IPC.PIP_COMMENT)!(trusted, request);
    expect(mocks.prompt).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
    prefs();
    await mocks.handlers.get(IPC.PIP_COMMENT)!(trusted, request);
    expect(mocks.prompt).not.toHaveBeenCalled();
    expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({ prompt: null, event: 'submitted' }), expect.any(AbortSignal));
  });
  it('uses only the attributed local transcript when prompt consent is on', async () => {
    prefs({ sharePrompts: true });
    await mocks.handlers.get(IPC.PIP_COMMENT)!(trusted, request);
    expect(mocks.transcript).toHaveBeenCalledWith('native-id');
    expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'Submitted idea' }), expect.any(AbortSignal));
  });
  it('keeps remote sessions and background attention events metadata-only', async () => {
    prefs({ sharePrompts: true });
    mocks.environment.mockReturnValue({ type: 'ssh' });
    await mocks.handlers.get(IPC.PIP_COMMENT)!(trusted, request);
    expect(mocks.prompt).not.toHaveBeenCalled();
    expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({ prompt: null }), expect.any(AbortSignal));
  });
  it('pauses while the application is minimized', async () => {
    prefs(); mocks.minimized = true;
    expect(await mocks.handlers.get(IPC.PIP_COMMENT)!(trusted, request)).toMatchObject({ status: 'paused' });
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it('sends the quip through the chosen backend only', async () => {
    prefs({ aiBackend: 'claude' });
    mocks.claude.mockResolvedValue({ status: 'ready', line: 'Haiku quip.', model: 'claude-haiku-5-5', reason: null });
    expect(await mocks.handlers.get(IPC.PIP_COMMENT)!(trusted, request)).toMatchObject({ line: 'Haiku quip.' });
    expect(mocks.claude).toHaveBeenCalledWith(expect.objectContaining({ cwd: expect.stringContaining('pip-workspace'), event: 'submitted' }), expect.any(AbortSignal));
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it('checks a named backend from the trusted window and rejects anything else', async () => {
    const handler = mocks.handlers.get(IPC.PIP_BACKEND_STATUS)!;
    mocks.status.mockResolvedValue({ backend: 'claude', ready: true, detail: 'Signed in.' });
    expect(await handler(trusted, 'claude')).toEqual({ backend: 'claude', ready: true, detail: 'Signed in.' });
    expect(mocks.status).toHaveBeenCalledWith('claude', expect.stringContaining('pip-workspace'), expect.any(AbortSignal));
    for (const raw of ['opencode', '', null, { backend: 'claude' }]) expect(() => validatePipBackend(raw)).toThrow('Invalid');
    expect(() => handler({ sender: {}, senderFrame: frame }, 'claude')).toThrow('Tether window');
    mocks.status.mockRejectedValue(new Error('private detail'));
    expect(await handler(trusted, 'codex')).toEqual({ backend: 'codex', ready: false, detail: 'Could not check sign-in. Using local quips.' });
  });
  it('abandons an earlier status check when another backend is picked', async () => {
    const handler = mocks.handlers.get(IPC.PIP_BACKEND_STATUS)!;
    const signals: AbortSignal[] = [];
    mocks.status.mockImplementation((backend: string, _cwd: string, signal: AbortSignal) => {
      signals.push(signal);
      return backend === 'codex' ? new Promise(() => {}) : Promise.resolve({ backend, ready: true, detail: 'ok' });
    });
    void handler(trusted, 'codex');
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    await handler(trusted, 'claude');
    expect(signals[0].aborted).toBe(true);
  });
});
