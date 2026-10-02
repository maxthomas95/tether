import { describe, expect, it, vi } from 'vitest';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
const config = vi.hoisted(() => ({ enabled: 'auto', url: 'https://office.example.test' }));
const open = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('electron', () => ({ shell: { openExternal: open } }));
vi.mock('./jobs/jobs-config', () => ({ readJobsConfig: () => config }));
import { hardenOfficeGuest, isAllowedAppNavigation } from './window-security';
describe('window navigation and Office guest policy', () => {
  it('allows only the exact bundled file or development entry point', () => {
    const appFile = path.resolve('app/index.html');
    expect(isAllowedAppNavigation(pathToFileURL(appFile).href + '?theme=x#section', appFile)).toBe(true);
    expect(isAllowedAppNavigation(pathToFileURL(path.resolve('other/index.html')).href, appFile)).toBe(false);
    expect(isAllowedAppNavigation('https://evil.test/index.html', appFile)).toBe(false);
    expect(isAllowedAppNavigation('http://localhost:5173/?theme=x', appFile, 'http://localhost:5173/')).toBe(true);
    expect(isAllowedAppNavigation('http://localhost:5173/evil', appFile, 'http://localhost:5173/')).toBe(false);
    expect(isAllowedAppNavigation('garbage', appFile)).toBe(false);
  });
  it('allows only the configured Office origin and removes guest privileges', () => {
    const listeners = new Map<string, Function>();
    const win = { webContents: { on: (name: string, fn: Function) => listeners.set(name, fn) } } as unknown as BrowserWindow;
    hardenOfficeGuest(win);
    const prefs = { preload: '/malicious.js', nodeIntegration: true };
    const preventDefault = vi.fn();
    listeners.get('will-attach-webview')!({ preventDefault }, prefs, { src: config.url });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(prefs).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true });
    expect(prefs.preload).toBeUndefined();
    for (const src of ['https://evil.test', 'file:///index.html', 'https://user:pass@office.example.test']) {
      listeners.get('will-attach-webview')!({ preventDefault }, {}, { src });
    }
    expect(preventDefault).toHaveBeenCalledTimes(3);
    const guestListeners = new Map<string, Function>(); const windowOpen = vi.fn();
    const request = vi.fn(); const check = vi.fn();
    listeners.get('did-attach-webview')!({}, { on: (name: string, fn: Function) => guestListeners.set(name, fn),
      setWindowOpenHandler: windowOpen, session: { setPermissionRequestHandler: request, setPermissionCheckHandler: check } });
    const grant = vi.fn(); request.mock.calls[0][0]({}, 'media', grant);
    expect(grant).toHaveBeenCalledWith(false); expect(check.mock.calls[0][0]()).toBe(false);
    expect(windowOpen.mock.calls[0][0]({ url: config.url })).toEqual({ action: 'deny' });
    for (const event of ['will-navigate', 'will-redirect']) {
      const blocked = vi.fn(); guestListeners.get(event)!({ preventDefault: blocked }, 'https://evil.test');
      expect(blocked).toHaveBeenCalledOnce();
    }
  });
});
