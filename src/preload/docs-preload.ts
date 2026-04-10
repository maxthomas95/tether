import { contextBridge, ipcRenderer } from 'electron';

const docsAPI = {
  onThemeChanged(cb: (themeName: string) => void): () => void {
    const handler = (_e: Electron.IpcRendererEvent, name: string) => cb(name);
    ipcRenderer.on('docs:theme-changed', handler);
    return () => ipcRenderer.removeListener('docs:theme-changed', handler);
  },
};

contextBridge.exposeInMainWorld('docsAPI', docsAPI);
