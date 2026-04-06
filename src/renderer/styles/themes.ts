import type { ITheme } from '@xterm/xterm';

export interface TetherTheme {
  name: string;
  label: string;
  isDark: boolean;
  css: {
    '--bg-primary': string;
    '--bg-sidebar': string;
    '--bg-header': string;
    '--bg-hover': string;
    '--bg-active': string;
    '--text-primary': string;
    '--text-secondary': string;
    '--text-muted': string;
    '--border-color': string;
    '--accent': string;
    '--status-running': string;
    '--status-waiting': string;
    '--status-idle': string;
    '--status-dead': string;
    '--btn-primary-text': string;
    '--shadow-opacity': string;
  };
  titlebar: {
    color: string;      // overlay background (matches sidebar/mantle)
    symbolColor: string; // min/max/close icon color
  };
  xterm: ITheme;
}

// ── Catppuccin Mocha ────────────────────────────────────────────────
export const mocha: TetherTheme = {
  name: 'mocha',
  label: 'Catppuccin Mocha',
  isDark: true,
  titlebar: { color: '#181825', symbolColor: '#cdd6f4' },
  css: {
    '--bg-primary': '#1e1e2e',
    '--bg-sidebar': '#181825',
    '--bg-header': '#313244',
    '--bg-hover': '#45475a',
    '--bg-active': '#585b70',
    '--text-primary': '#cdd6f4',
    '--text-secondary': '#bac2de',
    '--text-muted': '#6c7086',
    '--border-color': '#585b70',
    '--accent': '#b4befe',
    '--status-running': '#a6e3a1',
    '--status-waiting': '#f9e2af',
    '--status-idle': '#7f849c',
    '--status-dead': '#f38ba8',
    '--btn-primary-text': '#1e1e2e',
    '--shadow-opacity': '0.5',
  },
  xterm: {
    background: '#1e1e2e',
    foreground: '#cdd6f4',
    cursor: '#f5e0dc',
    cursorAccent: '#1e1e2e',
    selectionBackground: '#585b704d',
    selectionForeground: '#cdd6f4',
    black: '#45475a',
    red: '#f38ba8',
    green: '#a6e3a1',
    yellow: '#f9e2af',
    blue: '#89b4fa',
    magenta: '#f5c2e7',
    cyan: '#94e2d5',
    white: '#bac2de',
    brightBlack: '#585b70',
    brightRed: '#f38ba8',
    brightGreen: '#a6e3a1',
    brightYellow: '#f9e2af',
    brightBlue: '#89b4fa',
    brightMagenta: '#f5c2e7',
    brightCyan: '#94e2d5',
    brightWhite: '#a6adc8',
  },
};

// ── Catppuccin Macchiato ────────────────────────────────────────────
export const macchiato: TetherTheme = {
  name: 'macchiato',
  label: 'Catppuccin Macchiato',
  isDark: true,
  titlebar: { color: '#1e2030', symbolColor: '#cad3f5' },
  css: {
    '--bg-primary': '#24273a',
    '--bg-sidebar': '#1e2030',
    '--bg-header': '#363a4f',
    '--bg-hover': '#494d64',
    '--bg-active': '#5b6078',
    '--text-primary': '#cad3f5',
    '--text-secondary': '#b8c0e0',
    '--text-muted': '#6e738d',
    '--border-color': '#5b6078',
    '--accent': '#b7bdf8',
    '--status-running': '#a6da95',
    '--status-waiting': '#eed49f',
    '--status-idle': '#8087a2',
    '--status-dead': '#ed8796',
    '--btn-primary-text': '#24273a',
    '--shadow-opacity': '0.5',
  },
  xterm: {
    background: '#24273a',
    foreground: '#cad3f5',
    cursor: '#f4dbd6',
    cursorAccent: '#24273a',
    selectionBackground: '#5b60784d',
    selectionForeground: '#cad3f5',
    black: '#494d64',
    red: '#ed8796',
    green: '#a6da95',
    yellow: '#eed49f',
    blue: '#8aadf4',
    magenta: '#f5bde6',
    cyan: '#8bd5ca',
    white: '#b8c0e0',
    brightBlack: '#5b6078',
    brightRed: '#ed8796',
    brightGreen: '#a6da95',
    brightYellow: '#eed49f',
    brightBlue: '#8aadf4',
    brightMagenta: '#f5bde6',
    brightCyan: '#8bd5ca',
    brightWhite: '#a5adcb',
  },
};

// ── Catppuccin Frappé ───────────────────────────────────────────────
export const frappe: TetherTheme = {
  name: 'frappe',
  label: 'Catppuccin Frappé',
  isDark: true,
  titlebar: { color: '#292c3c', symbolColor: '#c6d0f5' },
  css: {
    '--bg-primary': '#303446',
    '--bg-sidebar': '#292c3c',
    '--bg-header': '#414559',
    '--bg-hover': '#51576d',
    '--bg-active': '#626880',
    '--text-primary': '#c6d0f5',
    '--text-secondary': '#b5bfe2',
    '--text-muted': '#737994',
    '--border-color': '#626880',
    '--accent': '#babbf1',
    '--status-running': '#a6d189',
    '--status-waiting': '#e5c890',
    '--status-idle': '#838ba7',
    '--status-dead': '#e78284',
    '--btn-primary-text': '#303446',
    '--shadow-opacity': '0.5',
  },
  xterm: {
    background: '#303446',
    foreground: '#c6d0f5',
    cursor: '#f2d5cf',
    cursorAccent: '#303446',
    selectionBackground: '#6268804d',
    selectionForeground: '#c6d0f5',
    black: '#51576d',
    red: '#e78284',
    green: '#a6d189',
    yellow: '#e5c890',
    blue: '#8caaee',
    magenta: '#f4b8e4',
    cyan: '#81c8be',
    white: '#b5bfe2',
    brightBlack: '#626880',
    brightRed: '#e78284',
    brightGreen: '#a6d189',
    brightYellow: '#e5c890',
    brightBlue: '#8caaee',
    brightMagenta: '#f4b8e4',
    brightCyan: '#81c8be',
    brightWhite: '#a5adce',
  },
};

// ── Catppuccin Latte ────────────────────────────────────────────────
export const latte: TetherTheme = {
  name: 'latte',
  label: 'Catppuccin Latte',
  isDark: false,
  titlebar: { color: '#e6e9ef', symbolColor: '#4c4f69' },
  css: {
    '--bg-primary': '#eff1f5',
    '--bg-sidebar': '#e6e9ef',
    '--bg-header': '#ccd0da',
    '--bg-hover': '#bcc0cc',
    '--bg-active': '#acb0be',
    '--text-primary': '#4c4f69',
    '--text-secondary': '#5c5f77',
    '--text-muted': '#9ca0b0',
    '--border-color': '#acb0be',
    '--accent': '#7287fd',
    '--status-running': '#40a02b',
    '--status-waiting': '#df8e1d',
    '--status-idle': '#8c8fa1',
    '--status-dead': '#d20f39',
    '--btn-primary-text': '#eff1f5',
    '--shadow-opacity': '0.15',
  },
  xterm: {
    background: '#eff1f5',
    foreground: '#4c4f69',
    cursor: '#dc8a78',
    cursorAccent: '#eff1f5',
    selectionBackground: '#acb0be80',
    selectionForeground: '#4c4f69',
    black: '#5c5f77',
    red: '#d20f39',
    green: '#40a02b',
    yellow: '#df8e1d',
    blue: '#1e66f5',
    magenta: '#ea76cb',
    cyan: '#179299',
    white: '#acb0be',
    brightBlack: '#6c6f85',
    brightRed: '#d20f39',
    brightGreen: '#40a02b',
    brightYellow: '#df8e1d',
    brightBlue: '#1e66f5',
    brightMagenta: '#ea76cb',
    brightCyan: '#179299',
    brightWhite: '#bcc0cc',
  },
};

// ── Default Dark (original Tether theme) ────────────────────────────
export const defaultDark: TetherTheme = {
  name: 'default-dark',
  label: 'Default Dark',
  isDark: true,
  titlebar: { color: '#252526', symbolColor: '#cccccc' },
  css: {
    '--bg-primary': '#1e1e1e',
    '--bg-sidebar': '#252526',
    '--bg-header': '#2d2d2d',
    '--bg-hover': '#2a2d2e',
    '--bg-active': '#37373d',
    '--text-primary': '#cccccc',
    '--text-secondary': '#858585',
    '--text-muted': '#5a5a5a',
    '--border-color': '#3c3c3c',
    '--accent': '#4fc1e9',
    '--status-running': '#22c55e',
    '--status-waiting': '#eab308',
    '--status-idle': '#6b7280',
    '--status-dead': '#ef4444',
    '--btn-primary-text': '#000000',
    '--shadow-opacity': '0.5',
  },
  xterm: {
    background: '#1e1e1e',
    foreground: '#cccccc',
    cursor: '#cccccc',
    cursorAccent: '#1e1e1e',
    selectionBackground: '#264f78',
  },
};

// ── Registry ────────────────────────────────────────────────────────
export const themes: Record<string, TetherTheme> = {
  mocha,
  macchiato,
  frappe,
  latte,
  'default-dark': defaultDark,
};

export const themeList: TetherTheme[] = [mocha, macchiato, frappe, latte, defaultDark];

export const DEFAULT_THEME = 'mocha';

export function getTheme(name: string): TetherTheme {
  return themes[name] ?? mocha;
}
