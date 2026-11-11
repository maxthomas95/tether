import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { beforeEach, expect, it, vi } from 'vitest';
import type { HandlerContext } from './helpers';

const registered = vi.hoisted(() => {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  return { calls, record: (name: string) => (...args: unknown[]) => { calls.push({ name, args }); } };
});

vi.mock('./session-handlers', () => ({ registerSessionHandlers: registered.record('session') }));
vi.mock('./env-handlers', () => ({ registerEnvHandlers: registered.record('env') }));
vi.mock('./coder-handlers', () => ({ registerCoderHandlers: registered.record('coder') }));
vi.mock('./profile-handlers', () => ({ registerProfileHandlers: registered.record('profile') }));
vi.mock('./config-handlers', () => ({ registerConfigHandlers: registered.record('config') }));
vi.mock('./dialog-handlers', () => ({ registerDialogHandlers: registered.record('dialog') }));
vi.mock('./git-handlers', () => ({ registerGitHandlers: registered.record('git') }));
vi.mock('./vault-handlers', () => ({ registerVaultHandlers: registered.record('vault') }));
vi.mock('./system-handlers', () => ({ registerSystemHandlers: registered.record('system') }));
vi.mock('./usage-handlers', () => ({ registerUsageHandlers: registered.record('usage') }));
vi.mock('./ssh-handlers', () => ({ registerSshHandlers: registered.record('ssh') }));
vi.mock('./keybindings-handlers', () => ({ registerKeybindingsHandlers: registered.record('keybindings') }));
vi.mock('./notifications-handlers', () => ({ registerNotificationsHandlers: registered.record('notifications') }));
vi.mock('./jobs-handlers', () => ({ registerJobsHandlers: registered.record('jobs') }));
vi.mock('./codex-handlers', () => ({ registerCodexHandlers: registered.record('codex') }));
vi.mock('./pip-handlers', () => ({ registerPipHandlers: registered.record('pip') }));
vi.mock('./gif-panel-handlers', () => ({ registerGifPanelHandlers: registered.record('gif-panel') }));
vi.mock('./clipboard-handlers', () => ({ registerClipboardHandlers: registered.record('clipboard') }));
vi.mock('./cli-maintenance-handlers', () => ({ registerCliMaintenanceHandlers: registered.record('cli-maintenance') }));
vi.mock('./workspace-recipes-handlers', () => ({ registerWorkspaceRecipesHandlers: registered.record('workspace-recipes') }));
vi.mock('./subagent-handlers', () => ({ registerSubagentHandlers: registered.record('subagent') }));
vi.mock('./theme-handlers', () => ({ registerThemeHandlers: registered.record('theme') }));

import { registerIpcHandlers } from './handlers';

function fakeWindow(destroyed = false) {
  const send = vi.fn();
  const window = { isDestroyed: () => destroyed, webContents: { send } } as unknown as BrowserWindow;
  return { window, send };
}

beforeEach(() => { registered.calls.length = 0; });

it('registers every handler module in the folder, each exactly once', () => {
  registerIpcHandlers(fakeWindow().window, () => null);

  const modules = fs.readdirSync(__dirname)
    .filter(file => file.endsWith('-handlers.ts'))
    .map(file => path.basename(file, '-handlers.ts'))
    .sort((a, b) => a.localeCompare(b));
  const names = registered.calls.map(call => call.name).sort((a, b) => a.localeCompare(b));
  expect(names).toEqual(modules);
});

it('gives every module the same main-window context, and themes the docs window too', () => {
  const { window } = fakeWindow();
  const getDocsWindow = () => null;

  registerIpcHandlers(window, getDocsWindow);

  const contexts = new Set(registered.calls.map(call => call.args[0]));
  expect(contexts.size).toBe(1);
  expect((registered.calls[0].args[0] as HandlerContext).mainWindow).toBe(window);
  expect(registered.calls.find(call => call.name === 'theme')?.args[1]).toBe(getDocsWindow);
});

it('delivers events to a live window and drops them once it is destroyed', () => {
  const live = fakeWindow();
  registerIpcHandlers(live.window, () => null);
  (registered.calls[0].args[0] as HandlerContext).send('session:data', 'id-1', 'bytes');
  expect(live.send).toHaveBeenCalledWith('session:data', 'id-1', 'bytes');

  registered.calls.length = 0;
  const closed = fakeWindow(true);
  registerIpcHandlers(closed.window, () => null);
  (registered.calls[0].args[0] as HandlerContext).send('session:data', 'id-1', 'bytes');
  expect(closed.send).not.toHaveBeenCalled();
});
