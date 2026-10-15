interface DocsNavigateTarget {
  page?: string;
  anchor?: string;
}

interface DocsAPI {
  listThemes(): Promise<import('../shared/theme-types').LocalThemeCatalog>;
  onThemeChanged(cb: (themeName: string, localThemes: import('../shared/theme-types').TetherTheme[]) => void): () => void;
  onNavigate(cb: (target: DocsNavigateTarget) => void): () => void;
}

interface Window {
  docsAPI: DocsAPI;
}
