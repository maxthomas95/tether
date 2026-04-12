import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import squirrelStartup from 'electron-squirrel-startup';
import { registerIpcHandlers } from './ipc/handlers';
import { sessionManager } from './session/session-manager';
import { getDb, closeDb } from './db/database';
import { ensureDefaultLocalEnvironment } from './db/environment-repo';
import { markAllRunningAsStopped } from './db/session-repo';
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

/** Returns the docs BrowserWindow if open, for theme-change forwarding. */
export function getDocsWindow(): BrowserWindow | null {
  return docsWindow;
}

function createDocsWindow(): void {
  if (docsWindow && !docsWindow.isDestroyed()) {
    docsWindow.focus();
    return;
  }

  const db = getDb();
  const savedThemeName = db.config.theme || DEFAULT_LOADER_THEME;
  const loaderTheme = getLoaderTheme(savedThemeName);

  docsWindow = new BrowserWindow({
    width: 900,
    height: 700,
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

  docsWindow.once('ready-to-show', () => {
    docsWindow?.show();
  });

  const themeQuery = `theme=${encodeURIComponent(savedThemeName)}`;
  if (DOCS_WINDOW_VITE_DEV_SERVER_URL) {
    const sep = DOCS_WINDOW_VITE_DEV_SERVER_URL.includes('?') ? '&' : '?';
    docsWindow.loadURL(`${DOCS_WINDOW_VITE_DEV_SERVER_URL}/docs-window.html${sep}${themeQuery}`);
  } else {
    docsWindow.loadFile(
      path.join(__dirname, `../renderer/${DOCS_WINDOW_VITE_NAME}/docs-window.html`),
      { search: themeQuery },
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

  // Wait until the renderer has painted its first frame (which includes
  // the inline boot loader in index.html) before showing the window.
  // This avoids a blank/white flash on launch.
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  registerIpcHandlers(mainWindow);

  ipcMain.handle(IPC.DOCS_OPEN, () => createDocsWindow());

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

  app.on('before-quit', () => {
    log.info('App shutting down');
    sessionManager.dispose();
    closeDb();
    closeLogger();
  });
}
