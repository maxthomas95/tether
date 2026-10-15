import type { ITheme } from '@xterm/xterm';

export const THEME_COLOR_TOKENS = [
  '--bg-primary', '--bg-sidebar', '--bg-header', '--bg-hover', '--bg-active',
  '--text-primary', '--text-secondary', '--text-muted', '--border-color', '--accent',
  '--status-running', '--status-waiting', '--status-idle', '--status-dead',
  '--btn-primary-text', '--surface-1', '--surface-2', '--surface-3', '--surface-4',
] as const;

export const TERMINAL_COLOR_KEYS = [
  'background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground', 'selectionForeground',
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
] as const;

export interface TetherTheme {
  name: string;
  label: string;
  isDark: boolean;
  css: Record<typeof THEME_COLOR_TOKENS[number], string> & { '--shadow-opacity': string };
  titlebar: { color: string; symbolColor: string };
  xterm: ITheme;
}

/** A complete, portable palette. Local ids are namespaced at load time. */
export interface ThemeFile extends Omit<TetherTheme, 'name'> {
  schemaVersion: 1;
  id: string;
}

export interface LocalThemeCatalog {
  directory: string;
  themes: TetherTheme[];
  issues: Array<{ file: string; message: string }>;
}
