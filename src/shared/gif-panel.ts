export interface GifPanelSettings {
  enabled: boolean;
  collapsed: boolean;
  sources: string[];
  recursive: boolean;
  rotationEnabled: boolean;
  intervalMs: number;
  scaleMode: 'auto' | 'original';
}

export type GifPanelSettingsPatch = Partial<Omit<GifPanelSettings, 'sources'>>;

export const DEFAULT_GIF_PANEL_SETTINGS: GifPanelSettings = {
  enabled: false,
  collapsed: false,
  sources: [],
  recursive: true,
  rotationEnabled: false,
  intervalMs: 5000,
  scaleMode: 'auto',
};

export interface GifPanelImage {
  id: string;
  name: string;
  /** Changes when an existing file is replaced, so the viewer reloads it. */
  version: string;
}

export interface GifPanelLibrary {
  images: GifPanelImage[];
  warnings: string[];
}

export interface GifPanelAPI {
  getSettings(): Promise<GifPanelSettings>;
  updateSettings(patch: GifPanelSettingsPatch): Promise<GifPanelSettings>;
  /** Opens a native folder picker; the renderer cannot grant arbitrary paths. */
  addSources(): Promise<GifPanelSettings>;
  removeSource(source: string): Promise<GifPanelSettings>;
  getLibrary(): Promise<GifPanelLibrary>;
  readImage(id: string): Promise<string>;
}
