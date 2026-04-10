interface DocsAPI {
  onThemeChanged(cb: (themeName: string) => void): () => void;
}

interface Window {
  docsAPI: DocsAPI;
}
