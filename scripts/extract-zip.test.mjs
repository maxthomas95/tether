import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import AdmZip from 'adm-zip';

// Exercise Packager's actual CommonJS call site, including the scoped override
// and its interop with Electron's ESM/native extractor.
const require = createRequire(import.meta.url);
const { extractElectronZip } = require('@electron/packager/dist/unzip.js');

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tether-extract-zip-'));
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = path.join(root, 'extracted');
  await mkdir(destination);
  return { root, destination, archive: path.join(root, 'archive.zip') };
}

test('Packager extracts ordinary files through the replacement', async t => {
  const { destination, archive } = await fixture(t);
  const zip = new AdmZip();
  zip.addFile('resources/example.txt', Buffer.from('archive contents'));
  await writeFile(archive, zip.toBuffer());

  await extractElectronZip(archive, destination);

  assert.equal(await readFile(path.join(destination, 'resources', 'example.txt'), 'utf8'), 'archive contents');
});

for (const kind of ['relative', 'absolute']) {
  test(`Packager rejects ${kind} symlink targets outside the extraction directory`, async t => {
    const { root, destination, archive } = await fixture(t);
    const outside = path.join(root, 'outside.txt');
    await writeFile(outside, 'unchanged');
    const target = kind === 'relative' ? '../outside.txt' : outside;
    const zip = new AdmZip();
    zip.addFile('escape', Buffer.from(target));
    const entry = zip.getEntry('escape');
    // Mark a Unix symlink even when generating the archive on Windows.
    entry.header.made = (3 << 8) | 20;
    entry.header.attr = (0o120777 << 16) >>> 0;
    await writeFile(archive, zip.toBuffer());

    await assert.rejects(extractElectronZip(archive, destination), /refusing to create symlink/);

    assert.equal(existsSync(path.join(destination, 'escape')), false);
    assert.equal(await readFile(outside, 'utf8'), 'unchanged');
  });
}
