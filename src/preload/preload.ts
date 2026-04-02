import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/constants';
import type {
  CreateSessionOptions, SessionInfo, SessionState,
  CreateEnvironmentOptions, EnvironmentInfo, TetherAPI,
} from '../shared/types';

const api: TetherAPI = {
  platform: process.platform,
  homeDir: process.env.USERPROFILE || process.env.HOME || '',

  session: {
    create: (opts: CreateSessionOptions): Promise<SessionInfo> => ipcRenderer.invoke(IPC.SESSION_CREATE, opts),
    list: (): Promise<SessionInfo[]> => ipcRenderer.invoke(IPC.SESSION_LIST),
    stop: (id: string): Promise<void> => ipcRenderer.invoke(IPC.SESSION_STOP, id),
    kill: (id: string): Promise<void> => ipcRenderer.invoke(IPC.SESSION_KILL, id),
    rename: (id: string, label: string): Promise<void> => ipcRenderer.invoke(IPC.SESSION_RENAME, id, label),
    remove: (id: string): Promise<void> => ipcRenderer.invoke(IPC.SESSION_REMOVE, id),
    sendInput: (id: string, data: string): void => { ipcRenderer.send(IPC.SESSION_INPUT, id, data); },
    resize: (id: string, cols: number, rows: number): void => { ipcRenderer.send(IPC.SESSION_RESIZE, id, cols, rows); },
    onData(cb: (id: string, data: string) => void): () => void {
      const h = (_e: Electron.IpcRendererEvent, id: string, data: string) => cb(id, data);
      ipcRenderer.on(IPC.SESSION_DATA, h);
      return () => ipcRenderer.removeListener(IPC.SESSION_DATA, h);
    },
    onStateChange(cb: (id: string, state: SessionState) => void): () => void {
      const h = (_e: Electron.IpcRendererEvent, id: string, state: SessionState) => cb(id, state);
      ipcRenderer.on(IPC.SESSION_STATE_CHANGE, h);
      return () => ipcRenderer.removeListener(IPC.SESSION_STATE_CHANGE, h);
    },
    onExited(cb: (id: string, code: number) => void): () => void {
      const h = (_e: Electron.IpcRendererEvent, id: string, code: number) => cb(id, code);
      ipcRenderer.on(IPC.SESSION_EXITED, h);
      return () => ipcRenderer.removeListener(IPC.SESSION_EXITED, h);
    },
  },

  environment: {
    list: (): Promise<EnvironmentInfo[]> => ipcRenderer.invoke(IPC.ENV_LIST),
    create: (opts: CreateEnvironmentOptions): Promise<EnvironmentInfo> => ipcRenderer.invoke(IPC.ENV_CREATE, opts),
    update: (id: string, opts: Partial<CreateEnvironmentOptions>): Promise<void> => ipcRenderer.invoke(IPC.ENV_UPDATE, id, opts),
    delete: (id: string): Promise<void> => ipcRenderer.invoke(IPC.ENV_DELETE, id),
  },

  dialog: {
    openDirectory: (): Promise<string | null> => ipcRenderer.invoke(IPC.DIALOG_OPEN_DIRECTORY),
  },
};

contextBridge.exposeInMainWorld('electronAPI', api);
