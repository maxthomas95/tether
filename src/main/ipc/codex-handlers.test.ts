import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
  account: vi.fn(), configuration: vi.fn(), session: vi.fn(), environment: vi.fn(),
}));
vi.mock('electron', () => ({ ipcMain: { handle: (key: string, handler: never) => mocks.handlers.set(key, handler) } }));
vi.mock('../codex/integration-service', () => ({ readCodexAccount: mocks.account, inspectCodexConfiguration: mocks.configuration }));
vi.mock('../session/session-manager', () => ({ sessionManager: { getSession: mocks.session } }));
vi.mock('../db/environment-repo', () => ({ getEnvironment: mocks.environment }));
import { registerCodexHandlers } from './codex-handlers';
import { IPC } from '../../shared/constants';

const frame = {};
const webContents = { mainFrame: frame };
const trusted = { sender: webContents, senderFrame: frame };
const mainWindow = { isDestroyed: () => false, webContents } as unknown as BrowserWindow;

describe('Codex inspection IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerCodexHandlers({ mainWindow, send: vi.fn() });
  });
  it('rejects other windows and nested frames before accessing account metadata', async () => {
    const handler = mocks.handlers.get(IPC.CODEX_ACCOUNT)!;
    await expect(handler({ sender: {}, senderFrame: frame })).rejects.toThrow('Tether window');
    await expect(handler({ sender: webContents, senderFrame: {} })).rejects.toThrow('Tether window');
    expect(mocks.account).not.toHaveBeenCalled();
    await handler(trusted);
    expect(mocks.account).toHaveBeenCalledOnce();
  });
  it('resolves project context from a local session instead of accepting a renderer path', async () => {
    mocks.session.mockReturnValue({ cliTool: 'codex', workingDir: '/projects/tether', environmentId: 'local' });
    mocks.environment.mockReturnValue({ type: 'local' });
    const handler = mocks.handlers.get(IPC.CODEX_CONFIGURATION)!;
    await handler(trusted, 'session-id');
    expect(mocks.configuration).toHaveBeenCalledWith('/projects/tether');
    await expect(handler(trusted, { cwd: '/arbitrary' })).rejects.toThrow('Choose a local');
  });
  it('refuses remote and deleted environments rather than reading local config for them', async () => {
    mocks.session.mockReturnValue({ cliTool: 'codex', workingDir: '/remote/project', environmentId: 'remote' });
    const handler = mocks.handlers.get(IPC.CODEX_CONFIGURATION)!;
    for (const env of [{ type: 'ssh' }, { type: 'coder' }, undefined]) {
      mocks.environment.mockReturnValue(env);
      await expect(handler(trusted, 'session-id')).rejects.toThrow('local Codex');
    }
    expect(mocks.configuration).not.toHaveBeenCalled();
  });
  it('supports user defaults and refuses missing or non-Codex sessions', async () => {
    const handler = mocks.handlers.get(IPC.CODEX_CONFIGURATION)!;
    await handler(trusted);
    expect(mocks.configuration).toHaveBeenCalledWith();
    for (const session of [undefined, { cliTool: 'claude' }]) {
      mocks.session.mockReturnValue(session);
      await expect(handler(trusted, 'session-id')).rejects.toThrow('no longer available');
    }
  });
});
