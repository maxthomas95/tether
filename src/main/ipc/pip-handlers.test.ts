import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  config: {} as Record<string, string>, generate: vi.fn(), prompt: vi.fn(), session: vi.fn(), environment: vi.fn(), transcript: vi.fn(),
  visible: true, minimized: false,
}));
vi.mock('electron', () => ({ app: { getPath: () => '/neutral' }, ipcMain: { handle: (key: string, fn: never) => mocks.handlers.set(key, fn) } }));
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn() }));
vi.mock('../db/database', () => ({ getDb: () => ({ config: mocks.config }) }));
vi.mock('../codex/pip-comment-client', () => ({ generatePipComment: mocks.generate }));
vi.mock('../pip/prompt-context', () => ({ readRecentPrompt: mocks.prompt }));
vi.mock('../session/session-manager', () => ({ sessionManager: { getSession: mocks.session } }));
vi.mock('../db/environment-repo', () => ({ getEnvironment: mocks.environment }));
vi.mock('../usage/usage-service', () => ({ usageService: { getLocalTranscriptPath: mocks.transcript } }));
import { registerPipHandlers, validatePipRequest } from './pip-handlers';
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
  });
  it('does not read prompts or generate until AI is explicitly enabled', async () => {
    await mocks.handlers.get(IPC.PIP_COMMENT)!(trusted, request);
    expect(mocks.prompt).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
    prefs();
    await mocks.handlers.get(IPC.PIP_COMMENT)!(trusted, request);
    expect(mocks.prompt).not.toHaveBeenCalled();
    expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({ prompt: null, event: 'submitted' }));
  });
  it('uses only the attributed local transcript when prompt consent is on', async () => {
    prefs({ sharePrompts: true });
    await mocks.handlers.get(IPC.PIP_COMMENT)!(trusted, request);
    expect(mocks.transcript).toHaveBeenCalledWith('native-id');
    expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'Submitted idea' }));
  });
  it('keeps remote sessions and background attention events metadata-only', async () => {
    prefs({ sharePrompts: true });
    mocks.environment.mockReturnValue({ type: 'ssh' });
    await mocks.handlers.get(IPC.PIP_COMMENT)!(trusted, request);
    expect(mocks.prompt).not.toHaveBeenCalled();
    expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({ prompt: null }));
  });
  it('pauses while the application is minimized', async () => {
    prefs(); mocks.minimized = true;
    expect(await mocks.handlers.get(IPC.PIP_COMMENT)!(trusted, request)).toMatchObject({ status: 'paused' });
    expect(mocks.generate).not.toHaveBeenCalled();
  });
});
