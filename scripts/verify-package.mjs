import fs from 'node:fs';
import path from 'node:path';
import { builtinModules, createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let asar;
try {
  asar = require('@electron/asar');
} catch (error) {
  console.error('verify:package requires @electron/asar, but it could not be resolved from this install.');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const outDir = path.resolve('out');
if (!fs.existsSync(outDir)) {
  console.error(`Packaged output is missing: ${outDir}`);
  process.exit(1);
}

const appDirs = fs.readdirSync(outDir, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => path.join(outDir, entry.name))
  .filter(dir => fs.existsSync(path.join(dir, 'resources', 'app.asar')));

if (appDirs.length === 0) {
  console.error(`No packaged app directory with resources/app.asar found under ${outDir}`);
  process.exit(1);
}
if (appDirs.length > 1) {
  console.error(`More than one packaged app directory found under ${outDir}: ${appDirs.join(', ')}`);
  process.exit(1);
}

const appDir = appDirs[0];
const resourcesDir = path.join(appDir, 'resources');
const asarPath = path.join(resourcesDir, 'app.asar');
const unpackedDir = path.join(resourcesDir, 'app.asar.unpacked');
// asar.listPackage returns platform-native separators (backslashes on
// Windows); normalize to forward slashes so the posix-style checks below match.
const asarFiles = asar.listPackage(asarPath).map(file => file.replace(/\\/g, '/').replace(/^\/+/, ''));
const unpackedFiles = fs.existsSync(unpackedDir) ? listFiles(unpackedDir) : [];
const failures = [];

function listFiles(root) {
  const files = [];
  const visit = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile()) files.push(path.relative(root, fullPath).replace(/\\/g, '/'));
    }
  };
  visit(root);
  return files;
}

function hasPackagedFile(relativePath) {
  return asarFiles.includes(relativePath) || unpackedFiles.includes(relativePath);
}

function packageIsPresent(packageName) {
  return hasPackagedFile(path.posix.join('node_modules', packageName, 'package.json'));
}

function addFailure(message) {
  failures.push(message);
}

const builtChunks = asarFiles.filter(file => /^\.vite\/build\/.*\.js$/.test(file));
if (builtChunks.length === 0) {
  addFailure('No built main-process chunks found at .vite/build/*.js in app.asar.');
}

const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
const runtimeBuiltins = new Set(['electron']);
const bareRequire = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
const builtChunkContents = [];

for (const chunk of builtChunks) {
  // asarFiles were normalized to forward slashes; extractFile wants the
  // archive's native separator.
  const contents = asar.extractFile(asarPath, chunk.split('/').join(path.sep)).toString('utf8');
  builtChunkContents.push({ chunk, contents });
  for (const match of contents.matchAll(bareRequire)) {
    const specifier = match[1];
    if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:') || builtins.has(specifier) || runtimeBuiltins.has(specifier)) continue;
    const packageName = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
    if (!packageIsPresent(packageName)) {
      addFailure(`${chunk} requires ${JSON.stringify(packageName)}, but it is absent from app.asar and app.asar.unpacked.`);
    }
  }
}

// Both externalized modules must be copied into the package. Only node-pty
// ships a native .node binding — ssh2 is pure JS (its native cpu-features
// speedup is optional and not installed here), so don't require one for it.
for (const packageName of ['node-pty', 'ssh2']) {
  if (!packageIsPresent(packageName)) {
    addFailure(`${packageName} is not present in app.asar or app.asar.unpacked.`);
  }
}
const ptyUnpacked = path.posix.join('node_modules', 'node-pty');
const ptyNativeBinding = unpackedFiles.some(file => file.startsWith(`${ptyUnpacked}/`) && file.endsWith('.node'));
if (!ptyNativeBinding) {
  addFailure('node-pty has no unpacked native .node binding.');
}

// Forge copies extraResources to their basename under resources/ (e.g.
// mcp-servers/tether-helm -> resources/tether-helm).
for (const resource of [
  'tether-helm/dist/index.js',
  'tether-cli-hook',
]) {
  const resourcePath = path.join(resourcesDir, ...resource.split('/'));
  if (!fs.existsSync(resourcePath)) {
    addFailure(`Required extraResource is missing: ${resource}`);
  }
}

for (const packageName of ['better-sqlite3', 'adm-zip']) {
  if (builtChunkContents.some(({ contents }) => new RegExp(`\\brequire\\(\\s*['"]${packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]\\s*\\)`).test(contents))) {
    addFailure(`Built main-process chunks still contain a bare require(${JSON.stringify(packageName)}).`);
  }
}

if (failures.length > 0) {
  console.error(`Package verification failed for ${appDir}:`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Package verification passed for ${appDir}.`);
console.log(`Checked ${builtChunks.length} main-process chunk(s), external native modules, and extra resources.`);
