import { THEME_COLOR_TOKENS, TERMINAL_COLOR_KEYS, type TetherTheme } from './theme-types';

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  return value as Record<string, unknown>;
}

function colors(value: unknown, keys: readonly string[], field: string): Record<string, string> {
  const input = record(value, field);
  const output: Record<string, string> = {};
  for (const key of keys) {
    if (typeof input[key] !== 'string' || !/^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(input[key])) {
      throw new Error(`${field}.${key} must be a #RRGGBB or #RRGGBBAA color.`);
    }
    output[key] = input[key];
  }
  const allowed = field === 'css' ? [...keys, '--shadow-opacity'] : keys;
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error(`${field} contains an unsupported field.`);
  return output;
}

export function parseThemeFile(value: unknown): TetherTheme {
  const input = record(value, 'Theme');
  if (input.schemaVersion !== 1) throw new Error('schemaVersion must be 1.');
  if (typeof input.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.id)) {
    throw new Error('id must contain 1–64 lowercase letters, numbers, or hyphens.');
  }
  if (typeof input.label !== 'string' || !input.label.trim() || input.label.length > 80 || /[\x00-\x1f\x7f]/.test(input.label)) {
    throw new Error('label must contain 1–80 printable characters.');
  }
  if (typeof input.isDark !== 'boolean') throw new Error('isDark must be true or false.');
  if (Object.keys(input).some(key => !['schemaVersion', 'id', 'label', 'isDark', 'css', 'titlebar', 'xterm'].includes(key))) {
    throw new Error('Theme contains an unsupported field.');
  }
  const css = colors(input.css, THEME_COLOR_TOKENS, 'css');
  const opacity = record(input.css, 'css')['--shadow-opacity'];
  if (typeof opacity !== 'string' || !/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(opacity)) {
    throw new Error('css.--shadow-opacity must be a number from "0" to "1".');
  }
  const titlebar = colors(input.titlebar, ['color', 'symbolColor'], 'titlebar');
  // Native window chrome requires opaque colors.
  if (Object.values(titlebar).some(color => color.length !== 7)) throw new Error('Titlebar colors must use #RRGGBB.');
  return {
    name: `local:${input.id}`, label: input.label.trim(), isDark: input.isDark,
    css: { ...css, '--shadow-opacity': opacity } as TetherTheme['css'],
    titlebar: titlebar as TetherTheme['titlebar'],
    xterm: colors(input.xterm, TERMINAL_COLOR_KEYS, 'xterm'),
  };
}
