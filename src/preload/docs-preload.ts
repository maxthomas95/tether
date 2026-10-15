import { contextBridge, ipcRenderer } from 'electron';
import type { LocalThemeCatalog, TetherTheme } from '../shared/theme-types';

interface DocsNavigateTarget {
  page?: string;
  anchor?: string;
}

const docsAPI = {
  listThemes: (): Promise<LocalThemeCatalog> => ipcRenderer.invoke('themes:list'),
  onThemeChanged(cb: (themeName: string, localThemes: TetherTheme[]) => void): () => void {
    const handler = (_e: Electron.IpcRendererEvent, name: string, themes: TetherTheme[]) => cb(name, themes);
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
