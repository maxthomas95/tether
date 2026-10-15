import { builtInThemeList, DEFAULT_THEME, getTheme } from './themes';
import type { TetherTheme } from './theme-types';

export interface LoaderTheme {
  bg: string;
  sidebar: string;
  text: string;
  muted: string;
  accent: string;
  border: string;
}

function loaderPalette(theme: TetherTheme): LoaderTheme {
  return {
    bg: theme.css['--bg-primary'], sidebar: theme.css['--bg-sidebar'],
    text: theme.css['--text-primary'], muted: theme.css['--text-muted'],
    accent: theme.css['--accent'], border: theme.css['--border-color'],
  };
}

export const LOADER_THEMES: Record<string, LoaderTheme> = Object.fromEntries(
  builtInThemeList.map(theme => [theme.name, loaderPalette(theme)]),
);
export const DEFAULT_LOADER_THEME = DEFAULT_THEME;
export function getLoaderTheme(name: string | null | undefined): LoaderTheme {
  return loaderPalette(getTheme(name || DEFAULT_THEME));
}
