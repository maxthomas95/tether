// Theme colors used by the boot loader (index.html) and the Electron
// BrowserWindow chrome (backgroundColor + titleBarOverlay). Kept minimal
// and shared so the main process can read the saved theme synchronously
// and paint the window in the right palette before the renderer mounts.
//
// The full theme registry lives in src/renderer/styles/themes.ts — these
// values must stay in sync with the corresponding entries there.

export interface LoaderTheme {
  bg: string;        // --bg-primary
  sidebar: string;   // --bg-sidebar (also titlebar overlay color)
  text: string;      // --text-primary (also titlebar symbol color)
  muted: string;     // --text-muted (subtitle)
  accent: string;    // --accent (spinner)
  border: string;    // --border-color (spinner track)
}

export const LOADER_THEMES: Record<string, LoaderTheme> = {
  mocha: {
    bg: '#1e1e2e',
    sidebar: '#181825',
    text: '#cdd6f4',
    muted: '#6c7086',
    accent: '#b4befe',
    border: '#313244',
  },
  macchiato: {
    bg: '#24273a',
    sidebar: '#1e2030',
    text: '#cad3f5',
    muted: '#6e738d',
    accent: '#b7bdf8',
    border: '#363a4f',
  },
  frappe: {
    bg: '#303446',
    sidebar: '#292c3c',
    text: '#c6d0f5',
    muted: '#737994',
    accent: '#babbf1',
    border: '#414559',
  },
  latte: {
    bg: '#eff1f5',
    sidebar: '#e6e9ef',
    text: '#4c4f69',
    muted: '#9ca0b0',
    accent: '#7287fd',
    border: '#ccd0da',
  },
  'default-dark': {
    bg: '#1e1e1e',
    sidebar: '#252526',
    text: '#cccccc',
    muted: '#5a5a5a',
    accent: '#4fc1e9',
    border: '#3c3c3c',
  },
};

export const DEFAULT_LOADER_THEME = 'mocha';

export function getLoaderTheme(name: string | null | undefined): LoaderTheme {
  if (name && LOADER_THEMES[name]) return LOADER_THEMES[name];
  return LOADER_THEMES[DEFAULT_LOADER_THEME];
}
