import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { registerIpcHandlers } from './ipc/handlers';
import { sessionManager } from './session/session-manager';
import { getDb, closeDb } from './db/database';
import { ensureDefaultLocalEnvironment } from './db/environment-repo';
import { markAllRunningAsStopped } from './db/session-repo';

let mainWindow: BrowserWindow | null = null;

const createWindow = () => {
  // Initialize persistence
  getDb();
  markAllRunningAsStopped();
  ensureDefaultLocalEnvironment();

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    title: 'Tether',
    icon: path.join(__dirname, '../../assets/icon.ico'),
    backgroundColor: '#1e1e2e',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#181825',
      symbolColor: '#cdd6f4',
      height: 36,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Note: preload.js is built from src/preload/preload.ts
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  registerIpcHandlers(mainWindow);

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  mainWindow.webContents.openDevTools();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
};

app.on('ready', createWindow);

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
  sessionManager.dispose();
  closeDb();
});
