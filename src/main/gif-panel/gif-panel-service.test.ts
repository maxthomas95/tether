import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GifPanelService, MAX_GIF_BYTES } from './gif-panel-service';

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
let root: string;
let source: string;
let service: GifPanelService;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'tether-gif-test-'));
  source = path.join(root, 'collection');
  await fs.mkdir(source);
  service = new GifPanelService({ enabled: true }, () => {});
  await service.addSources([source]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('tether-gif-test-')) throw new Error('Invalid test directory');
  await fs.rm(root, { recursive: true, force: true });
});

describe('local GIF library', () => {
  it('scans supported files, deduplicates overlapping roots, and respects recursion', async () => {
    const nested = path.join(source, 'nested');
    await fs.mkdir(nested);
    await fs.writeFile(path.join(source, 'b.GIF'), GIF);
    await fs.writeFile(path.join(nested, 'a.webp'), Buffer.from('RIFF0000WEBP0000'));
    await fs.writeFile(path.join(source, 'ignore.svg'), '<svg/>');
    await service.addSources([source, nested]);
    expect(service.getSettings().sources).toHaveLength(2);
    expect((await service.getLibrary()).images.map(image => image.name)).toEqual(['a.webp', 'b.GIF']);
    service.removeSource(nested);
    service.updateSettings({ recursive: false });
    expect((await service.getLibrary()).images.map(image => image.name)).toEqual(['b.GIF']);
  });

  it('loads an indexed image as a correctly typed data URL and rejects arbitrary paths', async () => {
    await fs.writeFile(path.join(source, 'loop.gif'), GIF);
    const { images } = await service.getLibrary();
    expect(await service.readImage(images[0].id)).toBe(`data:image/gif;base64,${GIF.toString('base64')}`);
    await expect(service.readImage(path.join(source, 'loop.gif'))).rejects.toThrow('no longer');
    await expect(service.readImage('../secret.gif')).rejects.toThrow('no longer');
  });

  it('refreshes added and deleted images and revokes a removed source immediately', async () => {
    const file = path.join(source, 'loop.gif');
    await fs.writeFile(file, GIF);
    const first = (await service.getLibrary()).images[0];
    await fs.writeFile(path.join(source, 'new.gif'), GIF);
    expect((await service.getLibrary()).images).toHaveLength(2);
    await fs.unlink(file);
    expect((await service.getLibrary()).images.map(image => image.name)).toEqual(['new.gif']);
    await expect(service.readImage(first.id)).rejects.toThrow();
    const next = (await service.getLibrary()).images[0];
    service.removeSource(source);
    await expect(service.readImage(next.id)).rejects.toThrow();
    expect((await service.getLibrary()).images).toEqual([]);
  });

  it('rejects oversized, empty, and disguised files without exposing their contents', async () => {
    const oversized = await fs.open(path.join(source, 'huge.gif'), 'w');
    await oversized.truncate(MAX_GIF_BYTES + 1);
    await oversized.close();
    await fs.writeFile(path.join(source, 'empty.gif'), '');
    await fs.writeFile(path.join(source, 'disguised.gif'), '<html>not an image</html>');
    const library = await service.getLibrary();
    expect(library.images.map(image => image.name)).toEqual(['disguised.gif']);
    expect(library.warnings.join(' ')).toContain('50 MB');
    await expect(service.readImage(library.images[0].id)).rejects.toThrow('not a supported');
  });

  it('rejects an indexed directory replaced by a junction or symlink', async () => {
    const nested = path.join(source, 'nested');
    const outside = path.join(root, 'outside');
    await fs.mkdir(nested);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(nested, 'loop.gif'), GIF);
    await fs.writeFile(path.join(outside, 'loop.gif'), GIF);
    const { images } = await service.getLibrary();
    await fs.rename(nested, path.join(root, 'original'));
    await fs.symlink(outside, nested, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(service.readImage(images[0].id)).rejects.toThrow('outside');
    expect((await service.getLibrary()).images).toEqual([]);
  });

  it('reports missing folders and stays inactive when disabled', async () => {
    await fs.rmdir(source);
    expect((await service.getLibrary()).warnings.join(' ')).toContain('Could not read');
    service.updateSettings({ enabled: false });
    expect(await service.getLibrary()).toEqual({ images: [], warnings: [] });
  });

  it('does not republish results from an in-flight scan after sources change', async () => {
    await fs.writeFile(path.join(source, 'loop.gif'), GIF);
    const pending = service.getLibrary();
    service.removeSource(source);
    expect((await pending).images).toEqual([]);
    expect((await service.getLibrary()).images).toEqual([]);
  });
});

describe('GIF preferences', () => {
  it('starts disabled, validates persisted data, and prevents source grants through settings', () => {
    const fresh = new GifPanelService(null, () => {});
    expect(fresh.getSettings()).toMatchObject({ enabled: false, rotationEnabled: false, sources: [] });
    const settings = service.updateSettings({ sources: [root], intervalMs: 1, scaleMode: '<script>', recursive: 'false' });
    expect(settings).toMatchObject({ sources: [source], intervalMs: 1000, scaleMode: 'auto', recursive: true });
    expect(service.updateSettings({ intervalMs: 999999 }).intervalMs).toBe(60000);
    expect(() => service.updateSettings(null)).toThrow('Invalid');
  });

  it('restores saved preferences and retains current state if persistence fails', () => {
    const persist = vi.fn();
    const original = new GifPanelService(null, persist);
    original.updateSettings({ enabled: true, rotationEnabled: true, collapsed: true, scaleMode: 'original' });
    const restored = new GifPanelService(persist.mock.calls[0][0], () => { throw new Error('disk full'); });
    expect(restored.getSettings()).toEqual(original.getSettings());
    expect(() => restored.updateSettings({ enabled: false })).toThrow('disk full');
    expect(restored.getSettings().enabled).toBe(true);
  });
});
