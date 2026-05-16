import { contextBridge, ipcRenderer } from 'electron';

interface DocsNavigateTarget {
  page?: string;
  anchor?: string;
}

const docsAPI = {
  onThemeChanged(cb: (themeName: string) => void): () => void {
    const handler = (_e: Electron.IpcRendererEvent, name: string) => cb(name);
    ipcRenderer.on('docs:theme-changed', handler);
    return () => ipcRenderer.removeListener('docs:theme-changed', handler);
  },
  onNavigate(cb: (target: DocsNavigateTarget) => void): () => void {
    const handler = (_e: Electron.IpcRendererEvent, target: DocsNavigateTarget) => cb(target);
    ipcRenderer.on('docs:navigate', handler);
    return () => ipcRenderer.removeListener('docs:navigate', handler);
  },
};

contextBridge.exposeInMainWorld('docsAPI', docsAPI);
