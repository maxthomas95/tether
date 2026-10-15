import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import example from '../../shared/example-theme.json';
import { parseThemeFile } from '../../shared/theme-format';
import { setLocalThemes } from '../../shared/themes';
import type { LocalThemeCatalog } from '../../shared/theme-types';

const MAX_THEME_BYTES = 64 * 1024;
const MAX_THEMES = 128;
let catalog: LocalThemeCatalog = { directory: '', themes: [], issues: [] };

export function getThemesDirectory(): string {
  return path.join(app.getPath('userData'), 'themes');
}

/** Seed only a new directory; updates and reloads never overwrite user files. */
export function ensureThemesDirectory(directory = getThemesDirectory()): void {
  if (fs.existsSync(directory)) {
    if (!fs.statSync(directory).isDirectory()) throw new Error('Themes path must be a directory.');
    return;
  }
  fs.mkdirSync(path.join(directory, 'example'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'example', 'theme.json'), JSON.stringify(example, null, 2) + '\n', { flag: 'wx' });
}

export function getLocalThemeCatalog(): LocalThemeCatalog {
  return catalog;
}

/** Bounded, local, data-only loading. A bad theme does not prevent startup. */
export function loadLocalThemes(directory = getThemesDirectory()): LocalThemeCatalog {
  const next: LocalThemeCatalog = { directory, themes: [], issues: [] };
  try {
    ensureThemesDirectory(directory);
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    const candidates = entries.filter(entry => entry.isDirectory() || (entry.isFile() && entry.name.endsWith('.json')));
    if (candidates.length > MAX_THEMES) next.issues.push({ file: 'themes', message: `Only the first ${MAX_THEMES} theme files or folders are loaded.` });
    const ids = new Set<string>();
    for (const entry of candidates.slice(0, MAX_THEMES)) {
      const file = entry.isDirectory() ? path.join(entry.name, 'theme.json') : entry.name;
      try {
        const target = path.join(directory, file);
        const info = fs.lstatSync(target);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('Theme must be a regular JSON file.');
        if (info.size > MAX_THEME_BYTES) throw new Error('Theme exceeds the 64 KiB size limit.');
        let value: unknown;
        try { value = JSON.parse(fs.readFileSync(target, 'utf8').replace(/^\uFEFF/, '')); }
        catch { throw new Error('Theme is not valid JSON.'); }
        const theme = parseThemeFile(value);
        if (ids.has(theme.name)) throw new Error('Another local theme already uses this id.');
        ids.add(theme.name);
        next.themes.push(theme);
      } catch (error) {
        next.issues.push({ file, message: error instanceof Error ? error.message : 'Could not read theme.' });
      }
    }
  } catch {
    next.issues.push({ file: 'themes', message: 'Could not open the local themes folder.' });
  }
  catalog = next;
  setLocalThemes(next.themes);
  return next;
}
