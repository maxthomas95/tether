import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';
import squirrelStartup from 'electron-squirrel-startup';
import { registerIpcHandlers } from './ipc/handlers';
import { sessionManager } from './session/session-manager';
import { quotaService } from './quota/quota-service';
import { usageService } from './usage/usage-service';
import { loadPrices } from './usage/model-pricing';
import { refreshPricesInBackground } from './usage/pricing-fetcher';
import { getDb, closeDb } from './db/database';
import { ensureDefaultLocalEnvironment } from './db/environment-repo';
import { markAllRunningAsStopped } from './db/session-repo';
import { startHookService, stopHookService } from './cli-config/hook-service';
import { createNotificationService, readPrefsFromConfig } from './notifications/notification-service';
import { getLoaderTheme, DEFAULT_LOADER_THEME } from '../shared/loader-themes';
import { IPC } from '../shared/constants';
import { createLogger, closeLogger } from './logger';

const log = createLogger('app');

// Handle Squirrel.Windows lifecycle events (--squirrel-install,
// --squirrel-firstrun, --squirrel-updated, --squirrel-obsolete,
// --squirrel-uninstall). Without this, the installer launches the full
// app UI for every event, producing the "multiple windows that respawn
// when closed" bug. Must run before any other app initialization.
if (squirrelStartup) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let docsWindow: BrowserWindow | null = null;
let hookShutdownDone = false;

/** Returns the docs BrowserWindow if open, for theme-change forwarding. */
export function getDocsWindow(): BrowserWindow | null {
  return docsWindow;
}

interface DocsOpenTarget {
  page?: string;
  anchor?: string;
}

function buildDocsQuery(themeName: string, target?: DocsOpenTarget): string {
  const parts = [`theme=${encodeURIComponent(themeName)}`];
  if (target?.page) parts.push(`page=${encodeURIComponent(target.page)}`);
  if (target?.anchor) parts.push(`anchor=${encodeURIComponent(target.anchor)}`);
  return parts.join('&');
}

function isAllowedAppNavigation(url: string, htmlFile: string, devServerUrl?: string): boolean {
  try {
    const parsed = new URL(url);
    if (devServerUrl) {
      const dev = new URL(devServerUrl);
      return parsed.origin === dev.origin;
    }
    return parsed.protocol === 'file:' && decodeURIComponent(parsed.pathname).replace(/\\/g, '/').endsWith(`/${htmlFile}`);
  } catch {
    return false;
  }
}

function openExternalWebUrl(url: string): void {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      shell.openExternal(url).catch(() => undefined);
    }
  } catch {
    // Ignore malformed navigation attempts.
  }
}

function hardenNavigation(win: BrowserWindow, htmlFile: string, devServerUrl?: string): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalWebUrl(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isAllowedAppNavigation(url, htmlFile, devServerUrl)) return;
    event.preventDefault();
    openExternalWebUrl(url);
  });
}

function createDocsWindow(target?: DocsOpenTarget): void {
  if (docsWindow && !docsWindow.isDestroyed()) {
    docsWindow.focus();
    if (target?.page || target?.anchor) {
      docsWindow.webContents.send(IPC.DOCS_NAVIGATE, target);
    }
    return;
  }

  const db = getDb();
  const savedThemeName = db.config.theme || DEFAULT_LOADER_THEME;
  const loaderTheme = getLoaderTheme(savedThemeName);

  // Center the docs window on the same monitor as the main window so it
  // doesn't get dropped on an unrelated display in multi-monitor setups.
  const DOCS_W = 900;
  const DOCS_H = 700;
  const mainBounds = mainWindow?.getBounds();
  const position = mainBounds
    ? {
        x: Math.round(mainBounds.x + (mainBounds.width - DOCS_W) / 2),
        y: Math.round(mainBounds.y + (mainBounds.height - DOCS_H) / 2),
      }
    : {};

  docsWindow = new BrowserWindow({
    width: DOCS_W,
    height: DOCS_H,
    ...position,
    parent: mainWindow ?? undefined,
    minWidth: 500,
    minHeight: 400,
    title: 'Tether Documentation',
    icon: path.join(__dirname, '../../assets/icon.ico'),
    backgroundColor: loaderTheme.bg,
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: loaderTheme.sidebar,
      symbolColor: loaderTheme.text,
      height: 36,
    },
    webPreferences: {
      preload: path.join(__dirname, 'docs-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  hardenNavigation(docsWindow, 'docs-window.html', DOCS_WINDOW_VITE_DEV_SERVER_URL);

  docsWindow.once('ready-to-show', () => {
    docsWindow?.show();
  });

  const docsQuery = buildDocsQuery(savedThemeName, target);
  if (DOCS_WINDOW_VITE_DEV_SERVER_URL) {
    const sep = DOCS_WINDOW_VITE_DEV_SERVER_URL.includes('?') ? '&' : '?';
    docsWindow.loadURL(`${DOCS_WINDOW_VITE_DEV_SERVER_URL}/docs-window.html${sep}${docsQuery}`);
  } else {
    docsWindow.loadFile(
      path.join(__dirname, `../renderer/${DOCS_WINDOW_VITE_NAME}/docs-window.html`),
      { search: docsQuery },
    );
  }

  docsWindow.on('closed', () => {
    docsWindow = null;
  });
}

const createWindow = () => {
  // Initialize persistence
  const db = getDb();
  markAllRunningAsStopped();
  ensureDefaultLocalEnvironment();

  // Read the saved theme synchronously so we can paint the window chrome
  // and the inline boot loader in the right palette before the renderer
  // mounts. Falls back to the default theme on first launch.
  const savedThemeName = db.config.theme || DEFAULT_LOADER_THEME;
  const loaderTheme = getLoaderTheme(savedThemeName);

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    title: 'Tether',
    icon: path.join(__dirname, '../../assets/icon.ico'),
    backgroundColor: loaderTheme.bg,
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: loaderTheme.sidebar,
      symbolColor: loaderTheme.text,
      height: 36,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Note: preload.js is built from src/preload/preload.ts
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  hardenNavigation(mainWindow, 'index.html', MAIN_WINDOW_VITE_DEV_SERVER_URL);

  // Block browser-style refresh shortcuts (Ctrl+R, Ctrl+Shift+R, F5).
  // Tether isn't a website — an accidental refresh disconnects the renderer
  // from live PTY sessions.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const ctrl = input.control || input.meta;
    if (ctrl && input.key.toLowerCase() === 'r') {
      event.preventDefault();
    }
    if (input.key === 'F5') {
      event.preventDefault();
    }
  });

  // Wait until the renderer has painted its first frame (which includes
  // the inline boot loader in index.html) before showing the window.
  // This avoids a blank/white flash on launch.
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();

    // Background update check — non-blocking, 15s after window shows.
    // TODO: Replace with electron-updater auto-update when code signing is implemented.
    setTimeout(async () => {
      try {
        const db = getDb();
        if (db.config.updateCheckEnabled === 'false') return;

        const { checkForUpdates } = await import('./update/update-checker');
        const channel = db.config.updateChannel === 'beta' ? 'beta' as const : 'stable' as const;
        const result = await checkForUpdates(channel);
        if (!result.updateAvailable) return;

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.UPDATE_AVAILABLE, result);
        }
      } catch {
        // Silent fail — don't annoy user on network/parse errors
      }
    }, 15_000);

    // Start usage tracking
    setTimeout(() => usageService.start(), 3_000);

    // Start quota polling after a short delay to avoid blocking startup
    setTimeout(() => {
      const db = getDb();
      if (db.config.quotaEnabled === 'false') {
        quotaService.setEnabled(false);
      } else {
        quotaService.start();
      }
    }, 5_000);
  });

  registerIpcHandlers(mainWindow);

  // Wire desktop notifications. Lives next to the IPC layer because the
  // click handler needs to push back to the renderer via webContents.send.
  // Re-reads prefs from the JSON config on every fire so changes from the
  // Settings dialog take effect without a restart.
  const notifier = createNotificationService({
    getWindow: () => mainWindow,
    getPrefs: () => readPrefsFromConfig(getDb().config),
    onSessionSelect: (sessionId: string) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.NOTIFICATION_SESSION_SELECT, sessionId);
      }
    },
  });
  sessionManager.setNotifier(notifier);

  ipcMain.handle(IPC.DOCS_OPEN, (_e, target?: DocsOpenTarget) => createDocsWindow(target));

  // Pass the saved theme name to the renderer via the URL so the inline
  // boot loader can apply matching colors before any JS runs.
  const themeQuery = `theme=${encodeURIComponent(savedThemeName)}`;
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    const sep = MAIN_WINDOW_VITE_DEV_SERVER_URL.includes('?') ? '&' : '?';
    mainWindow.loadURL(`${MAIN_WINDOW_VITE_DEV_SERVER_URL}${sep}${themeQuery}`);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
      { search: themeQuery },
    );
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
};

// In dev mode, use a separate single-instance lock so the dev server
// can run alongside a packaged exe without being blocked.
if (!app.isPackaged) {
  app.setName(app.getName() + '-dev');
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on('ready', () => {
    log.info('App ready, creating window');
    // Pick up the latest cached pricing JSON (or fall back to bundled)
    // before the renderer can request any cost calculations.
    loadPrices(app.getPath('userData'));
    // Background refresh — never awaited, never blocks startup. Failures
    // are logged inside the fetcher and leave the cache untouched.
    refreshPricesInBackground();
    // Boot CLI hook bridge + install settings overlays. Never awaited —
    // session creation degrades to byte-level if this hasn't completed
    // yet (envForSession returns {} until the bridge is up).
    startHookService().catch((err) => {
      log.warn('startHookService threw', { error: err instanceof Error ? err.message : String(err) });
    });
    createWindow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  app.on('before-quit', (event) => {
    log.info('App shutting down');
    // Hook teardown is async (uninstall settings.json mutation) but
    // before-quit is synchronous. Best-effort: preventDefault long enough
    // for the uninstall + bridge dispose, then re-quit. Capped so a hung
    // file write doesn't trap the user in the app.
    if (!hookShutdownDone) {
      event.preventDefault();
      const timer = setTimeout(() => {
        log.warn('Hook shutdown exceeded 2s — proceeding with quit anyway');
        hookShutdownDone = true;
        app.quit();
      }, 2000);
      stopHookService().finally(() => {
        clearTimeout(timer);
        hookShutdownDone = true;
        app.quit();
      });
      return;
    }
    usageService.dispose();
    quotaService.dispose();
    sessionManager.dispose();
    closeDb();
    closeLogger();
  });
}
