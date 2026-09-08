import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  DEFAULT_GIF_PANEL_SETTINGS,
  type GifPanelSettings,
  type GifPanelLibrary,
  type GifPanelImage,
} from '../../shared/gif-panel';

export const MAX_GIF_BYTES = 50 * 1024 * 1024;
const MAX_IMAGES = 2000;
const MAX_ENTRIES = 20000;
const MAX_SOURCES = 20;
const EXTENSIONS = new Set(['.gif', '.apng', '.webp']);

interface ImageFile extends GifPanelImage {
  filePath: string;
  source: string;
}

interface ScanDirectory {
  directory: string;
  source: string;
  depth: number;
}

interface ScanState {
  files: Map<string, ImageFile>;
  warnings: Set<string>;
  seen: Set<string>;
  entries: number;
}

function scanLimitReached(scan: ScanState): boolean {
  return scan.entries >= MAX_ENTRIES || scan.files.size >= MAX_IMAGES;
}

async function indexImage(filePath: string, name: string, source: string, scan: ScanState): Promise<void> {
  try {
    const stat = await fs.stat(filePath);
    if (stat.size === 0 || stat.size > MAX_GIF_BYTES) {
      scan.warnings.add('Empty files and images larger than 50 MB were skipped.');
      return;
    }
    const id = createHash('sha256').update(pathKey(filePath)).digest('hex');
    scan.files.set(id, { id, name, version: `${stat.mtimeMs}:${stat.size}`, filePath, source });
  } catch {
    scan.warnings.add(`Some images in ${source} could not be read.`);
  }
}

async function scanEntry(entry: Dirent, current: ScanDirectory, recursive: boolean, queue: ScanDirectory[], scan: ScanState): Promise<void> {
  const filePath = path.join(current.directory, entry.name);
  if (entry.isDirectory() && recursive) {
    if (current.depth < 32) queue.push({ directory: filePath, source: current.source, depth: current.depth + 1 });
    else scan.warnings.add('Folders deeper than 32 levels were skipped.');
  }
  if (!entry.isFile() || !EXTENSIONS.has(path.extname(entry.name).toLowerCase())) return;
  await indexImage(filePath, entry.name, current.source, scan);
}

async function scanDirectory(current: ScanDirectory, recursive: boolean, queue: ScanDirectory[], scan: ScanState): Promise<void> {
  const directoryKey = pathKey(current.directory);
  if (scan.seen.has(directoryKey)) return;
  scan.seen.add(directoryKey);
  try {
    // Do not follow directory symlinks/junctions, including replaced roots.
    if (pathKey(await fs.realpath(current.directory)) !== directoryKey) return;
    const dir = await fs.opendir(current.directory);
    for await (const entry of dir) {
      if (++scan.entries > MAX_ENTRIES || scan.files.size >= MAX_IMAGES) break;
      await scanEntry(entry, current, recursive, queue, scan);
    }
  } catch {
    scan.warnings.add(`Could not read ${current.directory}. Check that the folder is available.`);
  }
}

function pathKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isInside(source: string, candidate: string): boolean {
  const relative = path.relative(source, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function normalizeSettings(value: unknown): GifPanelSettings {
  const result = { ...DEFAULT_GIF_PANEL_SETTINGS, sources: [] as string[] };
  if (!value || typeof value !== 'object') return result;
  const input = value as Record<string, unknown>;
  for (const key of ['enabled', 'collapsed', 'recursive', 'rotationEnabled'] as const) {
    if (typeof input[key] === 'boolean') result[key] = input[key];
  }
  if (typeof input.intervalMs === 'number' && Number.isFinite(input.intervalMs)) {
    result.intervalMs = Math.min(60000, Math.max(1000, Math.round(input.intervalMs)));
  }
  if (input.scaleMode === 'auto' || input.scaleMode === 'original') result.scaleMode = input.scaleMode;
  if (Array.isArray(input.sources)) {
    const sources = input.sources.filter((item): item is string => typeof item === 'string' && path.isAbsolute(item));
    result.sources = [...new Map(sources.map(source => [pathKey(source), source])).values()].slice(0, MAX_SOURCES);
  }
  return result;
}

function imageMime(bytes: Buffer, extension: string): string | null {
  const header = bytes.subarray(0, 6).toString('ascii');
  if (extension === '.gif' && (header === 'GIF87a' || header === 'GIF89a')) return 'image/gif';
  if (extension === '.apng' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (extension === '.webp' && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Local media only. No PTY, session, networking, or renderer filesystem access. */
export class GifPanelService {
  private settings: GifPanelSettings;
  private files = new Map<string, ImageFile>();
  private revision = 0;
  private scan: Promise<GifPanelLibrary> | undefined;

  constructor(saved: unknown, private readonly persist: (settings: GifPanelSettings) => void) {
    this.settings = normalizeSettings(saved);
  }

  getSettings(): GifPanelSettings {
    return { ...this.settings, sources: [...this.settings.sources] };
  }

  private save(next: GifPanelSettings): GifPanelSettings {
    // Save first, so a disk error leaves the current settings intact.
    this.persist(next);
    const rescan = next.enabled !== this.settings.enabled || next.recursive !== this.settings.recursive ||
      JSON.stringify(next.sources) !== JSON.stringify(this.settings.sources);
    this.settings = next;
    if (rescan) {
      this.revision++;
      this.files.clear();
      this.scan = undefined;
    }
    return this.getSettings();
  }

  updateSettings(patch: unknown): GifPanelSettings {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid GIF panel settings.');
    return this.save(normalizeSettings({ ...this.settings, ...patch, sources: this.settings.sources }));
  }

  /** Called only with paths returned by the main process folder picker. */
  async addSources(selected: string[]): Promise<GifPanelSettings> {
    const sources: string[] = [];
    for (const source of selected) {
      const resolved = await fs.realpath(source);
      if (!(await fs.stat(resolved)).isDirectory()) throw new Error('Choose a folder containing GIFs.');
      sources.push(resolved);
    }
    const combined = [...new Map([...this.settings.sources, ...sources].map(source => [pathKey(source), source])).values()];
    if (combined.length > MAX_SOURCES) throw new Error(`Choose up to ${MAX_SOURCES} GIF folders.`);
    return this.save({ ...this.settings, sources: combined });
  }

  removeSource(source: unknown): GifPanelSettings {
    if (typeof source !== 'string') throw new Error('Invalid GIF folder.');
    return this.save({ ...this.settings, sources: this.settings.sources.filter(item => pathKey(item) !== pathKey(source)) });
  }

  async getLibrary(): Promise<GifPanelLibrary> {
    if (!this.settings.enabled) return { images: [], warnings: [] };
    if (this.scan) return this.scan;
    const revision = this.revision;
    const pending = this.scanFolders(this.getSettings(), revision);
    this.scan = pending;
    try {
      return await pending;
    } finally {
      if (this.scan === pending) this.scan = undefined;
    }
  }

  private async scanFolders(settings: GifPanelSettings, revision: number): Promise<GifPanelLibrary> {
    const scan: ScanState = { files: new Map(), warnings: new Set(), seen: new Set(), entries: 0 };
    // Reverse the stack so roots retain the user's configured order.
    const queue = settings.sources.map(source => ({ directory: source, source, depth: 0 })).reverse();
    while (queue.length && !scanLimitReached(scan)) {
      if (revision !== this.revision) return { images: [], warnings: [] };
      await scanDirectory(queue.pop()!, settings.recursive, queue, scan);
    }
    if (scanLimitReached(scan)) scan.warnings.add('Scan limit reached (2,000 images or 20,000 entries). Choose smaller folders.');
    if (revision !== this.revision) return { images: [], warnings: [] };
    this.files = scan.files;
    const images = [...scan.files.values()].map(({ id, name, version }) => ({ id, name, version }));
    images.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return { images, warnings: [...scan.warnings] };
  }

  async readImage(id: unknown): Promise<string> {
    const entry = typeof id === 'string' ? this.files.get(id) : undefined;
    if (!this.settings.enabled || !entry) throw new Error('Image is no longer in the GIF library. Rescan the folders.');
    const revision = this.revision;
    const resolved = await fs.realpath(entry.filePath);
    if (pathKey(resolved) !== pathKey(entry.filePath) || !isInside(entry.source, resolved)) {
      throw new Error('Linked images outside the GIF library cannot be opened.');
    }
    const handle = await fs.open(resolved, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 12 || stat.size > MAX_GIF_BYTES) throw new Error('Image must be a GIF, APNG, or WebP file under 50 MB.');
      // Fixed allocation prevents a growing file from bypassing the size limit.
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw new Error('Image changed while loading. Rescan the folders.');
        offset += bytesRead;
      }
      const mime = imageMime(bytes, path.extname(resolved).toLowerCase());
      if (!mime) throw new Error('This file is not a supported GIF, APNG, or WebP image.');
      if (revision !== this.revision) throw new Error('GIF folders changed while loading.');
      return `data:${mime};base64,${bytes.toString('base64')}`;
    } finally {
      await handle.close();
    }
  }
}
