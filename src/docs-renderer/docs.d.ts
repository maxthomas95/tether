interface DocsNavigateTarget {
  page?: string;
  anchor?: string;
}

interface DocsAPI {
  onThemeChanged(cb: (themeName: string) => void): () => void;
  onNavigate(cb: (target: DocsNavigateTarget) => void): () => void;
}

interface Window {
  docsAPI: DocsAPI;
}
