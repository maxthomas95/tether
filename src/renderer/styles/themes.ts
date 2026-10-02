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
    '--text-muted': '#a0a4ba',
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
    '--text-muted': '#a0a6c0',
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
    '--text-muted': '#adb3cc',
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
    '--text-muted': '#626579',
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

// ── Brass (rope / canvas / brass) ───────────────────────────────────
// Warm identity palette: canvas-tinted darks (instead of cool blue-purple),
// deeper shadows, copper/brass accent. Originally shipped as "Tether" but
// renamed to "Brass" — the brown clashed with the logo, so the lighter
// neutral "Default Dark" took over the Tether name. The internal `name:`
// stays as 'tether' to preserve persisted user settings and existing
// [data-theme='tether'] CSS selectors (tokens.css, loader-themes.ts).
export const tether: TetherTheme = {
  name: 'tether',
  label: 'Brass',
  isDark: true,
  titlebar: { color: '#1a1714', symbolColor: '#ece4d4' },
  css: {
    '--bg-primary': '#1f1c18',
    '--bg-sidebar': '#1a1714',
    '--bg-header': '#2c2723',
    '--bg-hover': '#3a342d',
    '--bg-active': '#4a4239',
    '--text-primary': '#ece4d4',
    '--text-secondary': '#c9bfae',
    '--text-muted': '#ad9f8b',
    '--border-color': '#3a342d',
    '--accent': '#c68a5c',
    '--status-running': '#22c55e',
    '--status-waiting': '#eab308',
    '--status-idle': '#6b7280',
    '--status-dead': '#ef4444',
    '--btn-primary-text': '#1f1c18',
    '--shadow-opacity': '0.65',
  },
  xterm: {
    background: '#1f1c18',
    foreground: '#ece4d4',
    cursor: '#c68a5c',
    cursorAccent: '#1f1c18',
    selectionBackground: '#c68a5c4d',
    selectionForeground: '#ece4d4',
    black: '#3a342d',
    red: '#e87b6e',
    green: '#a8c97a',
    yellow: '#e0bd6d',
    blue: '#7da7c2',
    magenta: '#d29ab4',
    cyan: '#7ec0bd',
    white: '#c9bfae',
    brightBlack: '#4a4239',
    brightRed: '#f0908a',
    brightGreen: '#bcd991',
    brightYellow: '#ecc985',
    brightBlue: '#95b9d1',
    brightMagenta: '#dcaec3',
    brightCyan: '#9ad2c5',
    brightWhite: '#ece4d4',
  },
};

// ── Tether (Default Dark) — house theme ─────────────────────────────
// Neutral cool-dark palette that pairs cleanly with the logo. This is
// the "Tether" theme presented to users. Internal `name:` stays as
// 'default-dark' to preserve persisted user settings and the existing
// [data-theme='default-dark'] CSS selectors (tokens.css, loader-themes.ts,
// docs-renderer). A "Tether Light" variant is an outstanding work item.
export const defaultDark: TetherTheme = {
  name: 'default-dark',
  label: 'Tether (Default Dark)',
  isDark: true,
  titlebar: { color: '#1e252d', symbolColor: '#e7eef5' },
  css: {
    '--bg-primary': '#171c22',
    '--bg-sidebar': '#1e252d',
    '--bg-header': '#252e38',
    '--bg-hover': '#303b47',
    '--bg-active': '#344655',
    '--text-primary': '#e7eef5',
    '--text-secondary': '#bdcbd8',
    '--text-muted': '#a7b5c4',
    '--border-color': '#3d4a58',
    '--accent': '#62d2eb',
    '--status-running': '#22c55e',
    '--status-waiting': '#eab308',
    '--status-idle': '#6b7280',
    '--status-dead': '#ef4444',
    '--btn-primary-text': '#000000',
    '--shadow-opacity': '0.5',
  },
  xterm: {
    background: '#171c22',
    foreground: '#e7eef5',
    cursor: '#e7eef5',
    cursorAccent: '#171c22',
    selectionBackground: '#264f78',
  },
};

// ── Tether Light (Default Light) — light parity of Tether ───────────
// VS Code Light+ inspired, paired with "Tether (Default Dark)". Same
// neutral cool palette flipped to a white canvas with a cool blue
// accent. Internal `name: 'tether-light'` is the key used by tokens.css,
// loader-themes.ts, and docs-renderer.
export const tetherLight: TetherTheme = {
  name: 'tether-light',
  label: 'Tether Light',
  isDark: false,
  titlebar: { color: '#f3f3f3', symbolColor: '#1f1f1f' },
  css: {
    '--bg-primary': '#ffffff',
    '--bg-sidebar': '#f3f3f3',
    '--bg-header': '#ececec',
    '--bg-hover': '#e8e8e8',
    '--bg-active': '#d6d6d6',
    '--text-primary': '#1f1f1f',
    '--text-secondary': '#616161',
    '--text-muted': '#646b78',
    '--border-color': '#d4d4d4',
    '--accent': '#0078d4',
    '--status-running': '#16a34a',
    '--status-waiting': '#d97706',
    '--status-idle': '#9ca3af',
    '--status-dead': '#dc2626',
    '--btn-primary-text': '#ffffff',
    '--shadow-opacity': '0.15',
  },
  xterm: {
    background: '#ffffff',
    foreground: '#1f1f1f',
    cursor: '#1f1f1f',
    cursorAccent: '#ffffff',
    selectionBackground: '#add6ff',
    selectionForeground: '#1f1f1f',
    black: '#000000',
    red: '#cd3131',
    green: '#00bc00',
    yellow: '#949800',
    blue: '#0451a5',
    magenta: '#bc05bc',
    cyan: '#0598bc',
    white: '#555555',
    brightBlack: '#666666',
    brightRed: '#cd3131',
    brightGreen: '#14ce14',
    brightYellow: '#b5ba00',
    brightBlue: '#0451a5',
    brightMagenta: '#bc05bc',
    brightCyan: '#0598bc',
    brightWhite: '#a5a5a5',
  },
};

// ── Nord ────────────────────────────────────────────────────────────
// Polar Night / Snow Storm / Frost / Aurora: https://www.nordtheme.com/
export const nord: TetherTheme = {
  name: 'nord',
  label: 'Nord',
  isDark: true,
  titlebar: { color: '#272d38', symbolColor: '#eceff4' },
  css: {
    '--bg-primary': '#2e3440',
    '--bg-sidebar': '#272d38',
    '--bg-header': '#3b4252',
    '--bg-hover': '#434c5e',
    '--bg-active': '#4c566a',
    '--text-primary': '#eceff4',
    '--text-secondary': '#d8dee9',
    '--text-muted': '#b3bdce',
    '--border-color': '#4c566a',
    '--accent': '#88c0d0',
    '--status-running': '#a3be8c',
    '--status-waiting': '#ebcb8b',
    '--status-idle': '#b3bdce',
    '--status-dead': '#bf616a',
    '--btn-primary-text': '#2e3440',
    '--shadow-opacity': '0.5',
  },
  xterm: {
    background: '#2e3440', foreground: '#d8dee9',
    cursor: '#88c0d0', cursorAccent: '#2e3440',
    selectionBackground: '#434c5e', selectionForeground: '#eceff4',
    black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b',
    blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
    brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b',
    brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4',
  },
};

// ── Gruvbox ─────────────────────────────────────────────────────────
// Retro groove palette: https://github.com/morhetz/gruvbox
export const gruvboxDark: TetherTheme = {
  name: 'gruvbox-dark',
  label: 'Gruvbox Dark',
  isDark: true,
  titlebar: { color: '#1d2021', symbolColor: '#ebdbb2' },
  css: {
    '--bg-primary': '#282828',
    '--bg-sidebar': '#1d2021',
    '--bg-header': '#32302f',
    '--bg-hover': '#3c3836',
    '--bg-active': '#504945',
    '--text-primary': '#ebdbb2',
    '--text-secondary': '#d5c4a1',
    '--text-muted': '#bdae93',
    '--border-color': '#665c54',
    '--accent': '#fe8019',
    '--status-running': '#b8bb26',
    '--status-waiting': '#fabd2f',
    '--status-idle': '#bdae93',
    '--status-dead': '#fb4934',
    '--btn-primary-text': '#282828',
    '--shadow-opacity': '0.55',
  },
  xterm: {
    background: '#282828', foreground: '#ebdbb2',
    cursor: '#fe8019', cursorAccent: '#282828',
    selectionBackground: '#504945', selectionForeground: '#fbf1c7',
    black: '#282828', red: '#cc241d', green: '#98971a', yellow: '#d79921',
    blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
    brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26', brightYellow: '#fabd2f',
    brightBlue: '#83a598', brightMagenta: '#d3869b', brightCyan: '#8ec07c', brightWhite: '#ebdbb2',
  },
};

export const gruvboxLight: TetherTheme = {
  name: 'gruvbox-light',
  label: 'Gruvbox Light',
  isDark: false,
  titlebar: { color: '#f2e5bc', symbolColor: '#3c3836' },
  css: {
    '--bg-primary': '#fbf1c7',
    '--bg-sidebar': '#f2e5bc',
    '--bg-header': '#ebdbb2',
    '--bg-hover': '#ebdbb2',
    '--bg-active': '#d5c4a1',
    '--text-primary': '#3c3836',
    '--text-secondary': '#504945',
    '--text-muted': '#665c54',
    '--border-color': '#bdae93',
    '--accent': '#af3a03',
    '--status-running': '#427b58',
    '--status-waiting': '#8f6200',
    '--status-idle': '#665c54',
    '--status-dead': '#9d0006',
    '--btn-primary-text': '#fbf1c7',
    '--shadow-opacity': '0.15',
  },
  xterm: {
    background: '#fbf1c7', foreground: '#3c3836',
    cursor: '#af3a03', cursorAccent: '#fbf1c7',
    selectionBackground: '#d5c4a1', selectionForeground: '#282828',
    black: '#3c3836', red: '#9d0006', green: '#79740e', yellow: '#b57614',
    blue: '#076678', magenta: '#8f3f71', cyan: '#427b58', white: '#7c6f64',
    brightBlack: '#928374', brightRed: '#9d0006', brightGreen: '#79740e', brightYellow: '#b57614',
    brightBlue: '#076678', brightMagenta: '#8f3f71', brightCyan: '#427b58', brightWhite: '#3c3836',
  },
};

// ── Harbor — Tether original ────────────────────────────────────────
// Ocean navy, sea-glass teal, and pale rope. The warm text keeps this
// distinct from Nord's steel blues while status colors retain their roles.
export const harbor: TetherTheme = {
  name: 'harbor',
  label: 'Harbor',
  isDark: true,
  titlebar: { color: '#101b23', symbolColor: '#e7e3d5' },
  css: {
    '--bg-primary': '#15232d',
    '--bg-sidebar': '#101b23',
    '--bg-header': '#1c303b',
    '--bg-hover': '#25414c',
    '--bg-active': '#31535f',
    '--text-primary': '#e7e3d5',
    '--text-secondary': '#c4d3d3',
    '--text-muted': '#a4b9bb',
    '--border-color': '#3e606b',
    '--accent': '#70c1b3',
    '--status-running': '#9bc88d',
    '--status-waiting': '#e8c078',
    '--status-idle': '#a4b9bb',
    '--status-dead': '#ee8f88',
    '--btn-primary-text': '#101b23',
    '--shadow-opacity': '0.55',
  },
  xterm: {
    background: '#15232d', foreground: '#e7e3d5',
    cursor: '#70c1b3', cursorAccent: '#15232d',
    selectionBackground: '#31535f', selectionForeground: '#f4f0e5',
    black: '#25414c', red: '#ee8f88', green: '#9bc88d', yellow: '#e8c078',
    blue: '#83b4d5', magenta: '#cba3c8', cyan: '#70c1b3', white: '#c4d3d3',
    brightBlack: '#6e929a', brightRed: '#ffaaa0', brightGreen: '#b4dda1', brightYellow: '#f5d595',
    brightBlue: '#9dcbea', brightMagenta: '#dfbadb', brightCyan: '#98dacd', brightWhite: '#f4f0e5',
  },
};

// ── Registry ────────────────────────────────────────────────────────
export const themes: Record<string, TetherTheme> = {
  mocha,
  macchiato,
  frappe,
  latte,
  tether,
  'default-dark': defaultDark,
  'tether-light': tetherLight,
  nord,
  'gruvbox-dark': gruvboxDark,
  'gruvbox-light': gruvboxLight,
  harbor,
};

export const themeList: TetherTheme[] = [mocha, macchiato, frappe, latte, tether, defaultDark, tetherLight, nord, gruvboxDark, gruvboxLight, harbor];

export const DEFAULT_THEME = 'mocha';

export function getTheme(name: string): TetherTheme {
  return themes[name] ?? mocha;
}
