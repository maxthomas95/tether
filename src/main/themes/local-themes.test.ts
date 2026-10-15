import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import example from '../../shared/example-theme.json';
import { getTheme, setLocalThemes } from '../../shared/themes';

vi.mock('electron', () => ({ app: { getPath: () => '' } }));
import { ensureThemesDirectory, loadLocalThemes } from './local-themes';

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-themes-')); });
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); setLocalThemes([]); });

function write(file: string, value: unknown) {
  const target = path.join(directory, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(value));
}

it('seeds a new folder with the complete example and preserves edits and deletions on reload', () => {
  const target = path.join(directory, 'themes');
  ensureThemesDirectory(target);
  const file = path.join(target, 'example', 'theme.json');
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(example);
  fs.writeFileSync(file, 'private edits');
  ensureThemesDirectory(target);
  expect(fs.readFileSync(file, 'utf8')).toBe('private edits');
  fs.unlinkSync(file);
  loadLocalThemes(target);
  expect(fs.existsSync(file)).toBe(false);
});

it('loads folders and loose JSON files, reloads edits, and removes deleted themes', () => {
  write('private/theme.json', { ...example, id: 'private' });
  write('other.json', { ...example, id: 'other' });
  expect(loadLocalThemes(directory).themes).toHaveLength(2);
  write('private/theme.json', { ...example, id: 'private', label: 'Edited' });
  loadLocalThemes(directory);
  expect(getTheme('local:private').label).toBe('Edited');
  fs.unlinkSync(path.join(directory, 'private', 'theme.json'));
  expect(loadLocalThemes(directory).themes.map(theme => theme.name)).toEqual(['local:other']);
  expect(getTheme('local:private').name).toBe('mocha');
});

it('reports duplicate ids, malformed JSON, oversized files, and incomplete palettes while loading valid themes', () => {
  write('a.json', example);
  write('b.json', example);
  write('bad.json', { ...example, css: {} });
  fs.writeFileSync(path.join(directory, 'syntax.json'), '{bad');
  fs.writeFileSync(path.join(directory, 'large.json'), ' '.repeat(65537));
  const result = loadLocalThemes(directory);
  expect(result.themes).toHaveLength(1);
  expect(result.issues.map(issue => issue.file)).toEqual(['b.json', 'bad.json', 'large.json', 'syntax.json']);
});

it('handles an unreadable themes directory without preventing startup', () => {
  const file = path.join(directory, 'file');
  fs.writeFileSync(file, 'not a directory');
  const result = loadLocalThemes(file);
  expect(result.themes).toEqual([]);
  expect(result.issues).toHaveLength(1);
});

it('bounds the number of files considered', () => {
  for (let i = 0; i < 130; i++) write(`${i}.json`, { ...example, id: `theme-${i}` });
  const result = loadLocalThemes(directory);
  expect(result.themes).toHaveLength(128);
  expect(result.issues[0].message).toContain('128');
});
