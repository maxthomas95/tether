import { afterEach, describe, expect, it } from 'vitest';
import example from './example-theme.json';
import { parseThemeFile } from './theme-format';
import { buildThemeQuery, getTheme, setLocalThemes, themeList } from './themes';
import { getLoaderTheme } from './loader-themes';

afterEach(() => setLocalThemes([]));

it('ships a complete editable example with all of the built-in palette controls', () => {
  const theme = parseThemeFile(example);
  expect(Object.keys(theme.css).sort()).toEqual(Object.keys(getTheme('harbor').css).sort());
  expect(Object.keys(theme.xterm).sort()).toEqual(Object.keys(getTheme('harbor').xterm).sort());
  expect(theme.name).toBe('local:example');
});

describe('invalid or executable theme data', () => {
  it.each([
    { ...example, schemaVersion: 2 },
    { ...example, id: '../private' },
    { ...example, label: '' },
    { ...example, isDark: 'false' },
    { ...example, css: { ...example.css, '--accent': 'url(https://example.com)' } },
    { ...example, css: { ...example.css, '--surface-3': 'red; display:none' } },
    { ...example, css: { ...example.css, '--shadow-opacity': '1.1' } },
    { ...example, css: { ...example.css, '--arbitrary-property': '#123456' } },
    { ...example, titlebar: { ...example.titlebar, color: '#12345678' } },
    { ...example, xterm: { ...example.xterm, foreground: undefined } },
    { ...example, script: 'alert(1)' },
  ])('rejects invalid input %#', value => expect(() => parseThemeFile(value)).toThrow());
});

it('keeps local ids separate from built-ins and supplies the same startup palette', () => {
  const local = parseThemeFile({ ...example, id: 'mocha', isDark: false });
  setLocalThemes([local]);
  expect(getTheme('mocha').name).toBe('mocha');
  expect(getTheme('local:mocha')).toBe(local);
  expect(themeList.at(-1)).toBe(local);
  const params = new URLSearchParams(buildThemeQuery(local.name));
  expect(JSON.parse(params.get('palette')!)).toEqual(local.css);
  expect(params.get('dark')).toBe('false');
  expect(getLoaderTheme(local.name).bg).toBe(local.css['--bg-primary']);
  expect(getTheme('__proto__').name).toBe('mocha');
  expect(getTheme('toString').name).toBe('mocha');
});
