import { shell, type BrowserWindow } from 'electron';
import { pathToFileURL } from 'node:url';
import { readJobsConfig } from './jobs/jobs-config';

export function isAllowedAppNavigation(url: string, filePath: string, devServerUrl?: string): boolean {
  try {
    const target = new URL(url);
    const expected = devServerUrl ? new URL(devServerUrl) : pathToFileURL(filePath);
    return target.origin === expected.origin && target.protocol === expected.protocol &&
      target.host === expected.host && target.pathname === expected.pathname;
  } catch { return false; }
}

function jobsOriginAllowed(url: string): boolean {
  try {
    const target = new URL(url);
    const config = readJobsConfig(false);
    return config.enabled === 'auto' && ['https:', 'http:'].includes(target.protocol) &&
      !target.username && !target.password && target.origin === new URL(config.url).origin;
  } catch { return false; }
}

export function hardenOfficeGuest(win: BrowserWindow): void {
  win.webContents.on('will-attach-webview', (event, prefs, params) => {
    if (!jobsOriginAllowed(params.src)) { event.preventDefault(); return; }
    delete prefs.preload;
    prefs.nodeIntegration = false;
    prefs.nodeIntegrationInSubFrames = false;
    prefs.nodeIntegrationInWorker = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    prefs.webSecurity = true;
    prefs.allowRunningInsecureContent = false;
  });
  win.webContents.on('did-attach-webview', (_event, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      if (jobsOriginAllowed(url)) void shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    });
    guest.on('will-navigate', (event, url) => {
      if (!jobsOriginAllowed(url)) event.preventDefault();
    });
    guest.on('will-redirect', (event, url) => {
      if (!jobsOriginAllowed(url)) event.preventDefault();
    });
    guest.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    guest.session.setPermissionCheckHandler(() => false);
  });
}
