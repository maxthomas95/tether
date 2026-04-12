#!/usr/bin/env node
// Tether release script — see RELEASE.md for usage and conventions.
//
// Phases (each is a no-op if its work is already done, so the script is
// safe to re-run after a partial failure):
//   1. preflight    — branch is main, tree clean, up to date with origin
//   2. version      — bump package.json to the target version
//   3. changelog    — ensure a CHANGELOG.md section exists for the new version
//   4. commit+tag   — make the bump commit and lightweight tag
//   5. push         — push main + tag to origin
//   6. build        — npm run make
//   7. assets       — locate Setup.exe and portable zip, rename to convention
//   8. publish      — create Gitea release (prerelease=true) + upload assets
//   9. github       — create GitHub release (mirror) + upload assets
//
// Usage:
//   node scripts/release.mjs alpha.N            # cut a new alpha
//   node scripts/release.mjs beta.N             # cut a new beta
//   node scripts/release.mjs alpha.N --resume   # skip phases that are already done
//   node scripts/release.mjs alpha.N --dry-run  # print what would happen
//   node scripts/release.mjs --next             # auto-pick next prerelease number
//
// Environment:
//   GITEA_TOKEN_FILE   override the default Gitea token path
//                      (default: ~/.tether/gitea-token)
//   GITHUB_TOKEN_FILE  override the default GitHub token path
//                      (default: ~/.tether/github-token)

import { execSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { argv, exit, platform } from 'node:process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

// ─── Config ──────────────────────────────────────────────────────────────────

const REPO_OWNER = 'ThomasHomeCompany';
const REPO_NAME  = 'tether';
const GITEA_BASE = 'https://gitea.thomashomecompany.com';
const DEFAULT_TOKEN_FILE = join(process.env.HOME || process.env.USERPROFILE, '.tether', 'gitea-token');

const GITHUB_OWNER = 'maxthomas95';
const GITHUB_REPO  = 'tether';
const GITHUB_BASE  = 'https://api.github.com';
const DEFAULT_GITHUB_TOKEN_FILE = join(process.env.HOME || process.env.USERPROFILE, '.tether', 'github-token');

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// ─── Utilities ───────────────────────────────────────────────────────────────

const args = argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const RESUME  = args.includes('--resume');
const NEXT    = args.includes('--next');

function log(msg)  { console.log(`\x1b[36m▸\x1b[0m ${msg}`); }
function ok(msg)   { console.log(`\x1b[32m✓\x1b[0m ${msg}`); }
function warn(msg) { console.log(`\x1b[33m!\x1b[0m ${msg}`); }
function die(msg)  { console.error(`\x1b[31m✗\x1b[0m ${msg}`); exit(1); }

function sh(cmd, opts = {}) {
  if (DRY_RUN && opts.mutating) {
    log(`[dry-run] would run: ${cmd}`);
    return '';
  }
  return execSync(cmd, { cwd: REPO_ROOT, encoding: 'utf8', stdio: opts.inherit ? 'inherit' : 'pipe', ...opts }).toString().trim();
}

function shStream(cmd, args = []) {
  // For long-running commands where we want live output (npm run make).
  if (DRY_RUN) { log(`[dry-run] would run: ${cmd} ${args.join(' ')}`); return 0; }
  const r = spawnSync(cmd, args, { cwd: REPO_ROOT, stdio: 'inherit', shell: platform === 'win32' });
  return r.status;
}

function curlUpload(filePath, url, authHeader) {
  // Use curl for large file uploads — Node.js fetch chokes on 150MB+ bodies.
  if (DRY_RUN) { log(`[dry-run] would curl-upload ${basename(filePath)}`); return; }
  const r = spawnSync('curl', [
    '--fail', '--silent', '--show-error',
    '--connect-timeout', '30',
    '--max-time', '600',
    '-X', 'POST',
    '-H', authHeader,
    '-H', 'Content-Type: application/octet-stream',
    '--data-binary', `@${filePath}`,
    url,
  ], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: platform === 'win32' });
  if (r.status !== 0) {
    const stderr = r.stderr?.toString().trim() || '';
    throw new Error(`curl upload failed (exit ${r.status}): ${stderr}`);
  }
}

function readJSON(path)  { return JSON.parse(readFileSync(path, 'utf8')); }
function writeJSON(path, obj) { writeFileSync(path, JSON.stringify(obj, null, 2) + '\n'); }

function readToken() {
  const tokenFile = process.env.GITEA_TOKEN_FILE || DEFAULT_TOKEN_FILE;
  if (!existsSync(tokenFile)) die(`Gitea token not found at ${tokenFile}. Set GITEA_TOKEN_FILE or place the token there.`);
  return readFileSync(tokenFile, 'utf8').trim();
}

async function gitea(method, path, { body, headers, query } = {}) {
  const token = readToken();
  const url = new URL(`/api/v1${path}`, GITEA_BASE);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/json',
      ...(body && !(body instanceof Buffer) ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body instanceof Buffer ? body : (body ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Gitea ${method} ${path} → ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

function readGithubToken() {
  const tokenFile = process.env.GITHUB_TOKEN_FILE || DEFAULT_GITHUB_TOKEN_FILE;
  if (!existsSync(tokenFile)) die(`GitHub token not found at ${tokenFile}. Set GITHUB_TOKEN_FILE or place the token there.`);
  return readFileSync(tokenFile, 'utf8').trim();
}

async function github(method, path, { body, headers, query } = {}) {
  const token = readGithubToken();
  const url = new URL(path, GITHUB_BASE);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body && !(body instanceof Buffer) ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body instanceof Buffer ? body : (body ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GitHub ${method} ${path} → ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

// ─── Version + alpha resolution ──────────────────────────────────────────────

function currentPackageVersion() {
  return readJSON(join(REPO_ROOT, 'package.json')).version;
}

function bumpPatch(version) {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) die(`Cannot parse version: ${version}`);
  return `${m[1]}.${m[2]}.${parseInt(m[3], 10) + 1}`;
}

async function nextPrereleaseNumber(channel) {
  const releases = await gitea('GET', `/repos/${REPO_OWNER}/${REPO_NAME}/releases`);
  let max = 0;
  for (const r of releases) {
    const m = r.tag_name.match(new RegExp(`-${channel}\\.(\\d+)$`));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

// ─── Phases ──────────────────────────────────────────────────────────────────

function phasePreflight() {
  log('Phase 1/9: preflight');
  const branch = sh('git rev-parse --abbrev-ref HEAD');
  if (branch !== 'main') die(`Not on main (currently on ${branch})`);

  const status = sh('git status --porcelain');
  if (status) {
    if (RESUME) warn(`Working tree not clean (--resume mode, continuing):\n${status}`);
    else die(`Working tree not clean:\n${status}`);
  }

  sh('git fetch origin main');
  const local  = sh('git rev-parse main');
  const remote = sh('git rev-parse origin/main');
  if (local !== remote) {
    if (RESUME) warn(`Local main differs from origin/main (--resume mode, continuing)`);
    else die(`Local main (${local.slice(0,7)}) differs from origin/main (${remote.slice(0,7)}). Pull or push first.`);
  }
  ok('preflight passed');
}

function phaseVersion(targetVersion) {
  log(`Phase 2/9: version → ${targetVersion}`);
  const pkgPath = join(REPO_ROOT, 'package.json');
  const pkg = readJSON(pkgPath);
  if (pkg.version === targetVersion) {
    ok(`package.json already at ${targetVersion}`);
    return;
  }
  pkg.version = targetVersion;
  if (!DRY_RUN) writeJSON(pkgPath, pkg);
  ok(`bumped package.json to ${targetVersion}`);
}

function phaseChangelog(version, prereleaseTag) {
  log(`Phase 3/9: changelog`);
  const path = join(REPO_ROOT, 'CHANGELOG.md');
  const content = readFileSync(path, 'utf8');
  const heading = `## [${version}-${prereleaseTag}]`;
  if (content.includes(heading)) {
    ok(`CHANGELOG.md already has section for ${version}-${prereleaseTag}`);
    return;
  }
  // Generate a draft from git log since the previous tag.
  let prevTag = '';
  try { prevTag = sh('git describe --tags --abbrev=0 HEAD'); } catch { /* no prior tag */ }
  const range = prevTag ? `${prevTag}..HEAD` : '';
  const commits = prevTag ? sh(`git log ${range} --oneline --no-merges`) : '';
  const today = new Date().toISOString().slice(0, 10);
  const draft = [
    `## [${version}-${prereleaseTag}] — ${today}`,
    '',
    '### New Features',
    '- _(fill in)_',
    '',
    '### Bug Fixes',
    '- _(fill in)_',
    '',
    commits ? '<!-- commits since previous tag (delete this block before release):' : '',
    commits || '',
    commits ? '-->' : '',
    '',
    '---',
    '',
  ].filter(Boolean).join('\n');
  const insertAfter = '---\n\n';
  const idx = content.indexOf(insertAfter);
  if (idx === -1) die('Could not find insertion point in CHANGELOG.md (expected `---` separator after header)');
  const newContent = content.slice(0, idx + insertAfter.length) + draft + content.slice(idx + insertAfter.length);
  if (!DRY_RUN) writeFileSync(path, newContent);
  warn(`Drafted CHANGELOG.md section for ${version}-${prereleaseTag}. Edit it before publishing if needed.`);
}

function phaseCommitTag(version, prereleaseTag) {
  log(`Phase 4/9: commit + tag`);
  const tag = `v${version}-${prereleaseTag}`;
  // Is the tag already there?
  const tagExists = sh(`git tag -l ${tag}`);
  if (tagExists) {
    ok(`tag ${tag} already exists, skipping commit+tag`);
    return tag;
  }
  // Are there staged or modified release files to commit?
  const releaseFileDiff = sh('git diff --name-only HEAD -- package.json CHANGELOG.md');
  if (releaseFileDiff) {
    sh('git add package.json CHANGELOG.md', { mutating: true });
    const msg = `Bump to v${version}, update CHANGELOG for ${prereleaseTag}`;
    sh(`git commit -m "${msg}"`, { mutating: true });
  } else {
    ok('version bump already committed, just tagging');
  }
  sh(`git tag ${tag}`, { mutating: true });
  ok(`tagged ${tag}`);
  return tag;
}

function phasePush(tag) {
  log(`Phase 5/9: push`);
  // Check if origin/main is behind local main.
  sh('git fetch origin main');
  const ahead = sh(`git rev-list origin/main..main --count`);
  if (parseInt(ahead, 10) > 0) {
    sh('git push origin main', { mutating: true });
    ok('pushed main');
  } else {
    ok('main already pushed');
  }
  // Check remote tag.
  const remoteTag = sh(`git ls-remote origin refs/tags/${tag}`);
  if (remoteTag) {
    ok(`tag ${tag} already on origin`);
  } else {
    sh(`git push origin ${tag}`, { mutating: true });
    ok(`pushed tag ${tag}`);
  }
}

function findFirst(dir, predicate) {
  if (!existsSync(dir)) return null;
  const hits = readdirSync(dir).filter(predicate);
  return hits.length ? join(dir, hits[0]) : null;
}

function locateArtifacts(version) {
  const squirrelDir = join(REPO_ROOT, 'out', 'make', 'squirrel.windows', 'x64');
  const zipDir      = join(REPO_ROOT, 'out', 'make', 'zip', 'win32', 'x64');
  const setupPath = findFirst(squirrelDir, f => f.toLowerCase().endsWith('setup.exe') && f.includes(version));
  const zipPath   = findFirst(zipDir, f => f.toLowerCase().endsWith('.zip') && f.includes(version));
  return { setupPath, zipPath };
}

function phaseBuild(version) {
  log(`Phase 6/9: build (npm run make)`);
  let { setupPath, zipPath } = locateArtifacts(version);
  if (setupPath && zipPath) {
    ok(`build artifacts already present for ${version}, skipping`);
    return { setupPath, zipPath };
  }
  const code = shStream('npm', ['run', 'make']);
  if (code !== 0) die(`npm run make failed (exit ${code})`);
  if (DRY_RUN) {
    ok('build skipped (dry-run)');
    return { setupPath: '<dry-run>', zipPath: '<dry-run>' };
  }
  ({ setupPath, zipPath } = locateArtifacts(version));
  if (!setupPath) die(`Setup.exe matching version ${version} not found under out/make/squirrel.windows/x64/`);
  if (!zipPath)   die(`Portable zip matching version ${version} not found under out/make/zip/win32/x64/`);
  ok(`found Setup.exe: ${basename(setupPath)}`);
  ok(`found portable zip: ${basename(zipPath)}`);
  return { setupPath, zipPath };
}

function phaseAssets(version, { setupPath, zipPath }) {
  log(`Phase 7/9: assets`);
  // Tether-{version}-Setup.exe and Tether-{version}-portable.zip
  // We don't actually rename the files on disk — we just record the upload-name.
  const setupName = `Tether-${version}-Setup.exe`;
  const zipName   = `Tether-${version}-portable.zip`;
  if (DRY_RUN && setupPath === '<dry-run>') {
    ok(`will upload as ${setupName}`);
    ok(`will upload as ${zipName}`);
  } else {
    ok(`will upload as ${setupName} (${(statSync(setupPath).size/1024/1024).toFixed(1)} MB)`);
    ok(`will upload as ${zipName} (${(statSync(zipPath).size/1024/1024).toFixed(1)} MB)`);
  }
  return [
    { path: setupPath, name: setupName },
    { path: zipPath,   name: zipName },
  ];
}

async function phasePublish(version, prereleaseTag, assets) {
  log(`Phase 8/9: publish to Gitea`);
  const tag = `v${version}-${prereleaseTag}`;
  const isPrerelease = prereleaseTag.startsWith('alpha.');

  // Read the CHANGELOG section for this version to use as the release body.
  const changelog = readFileSync(join(REPO_ROOT, 'CHANGELOG.md'), 'utf8');
  const sectionRe = new RegExp(`(## \\[${version}-${prereleaseTag}\\][\\s\\S]*?)(?=\\n## \\[|$)`);
  const sectionMatch = changelog.match(sectionRe);
  let body = sectionMatch ? sectionMatch[1].trim() : `Release ${tag}`;
  // Strip the leading "## [version] — date" heading from the body since Gitea shows the title separately.
  body = body.replace(/^## \[.*?\][^\n]*\n+/, '');
  // Strip trailing --- separator if present.
  body = body.replace(/\n+---\s*$/, '').trim();

  // Does the release already exist?
  let release = null;
  try {
    release = await gitea('GET', `/repos/${REPO_OWNER}/${REPO_NAME}/releases/tags/${tag}`);
    ok(`release ${tag} already exists (id ${release.id})`);
  } catch (e) {
    if (!String(e).includes('404')) throw e;
  }

  if (!release) {
    if (DRY_RUN) { log(`[dry-run] would create release ${tag}`); return; }
    release = await gitea('POST', `/repos/${REPO_OWNER}/${REPO_NAME}/releases`, {
      body: {
        tag_name: tag,
        target_commitish: 'main',
        name: tag,
        body,
        draft: false,
        prerelease: isPrerelease,
      },
    });
    ok(`created release ${tag} (id ${release.id})`);
  }

  // Upload assets, skipping any that already exist.
  const existing = new Set((release.assets || []).map(a => a.name));
  for (const asset of assets) {
    if (existing.has(asset.name)) {
      ok(`asset ${asset.name} already uploaded`);
      continue;
    }
    if (DRY_RUN) { log(`[dry-run] would upload ${asset.name}`); continue; }
    log(`uploading ${asset.name}...`);
    const giteaUrl = `${GITEA_BASE}/api/v1/repos/${REPO_OWNER}/${REPO_NAME}/releases/${release.id}/assets?name=${encodeURIComponent(asset.name)}`;
    curlUpload(asset.path, giteaUrl, `Authorization: token ${readToken()}`);
    ok(`uploaded ${asset.name}`);
  }

  console.log(`\n\x1b[32m✓\x1b[0m Release published: ${GITEA_BASE}/${REPO_OWNER}/${REPO_NAME}/releases/tag/${tag}\n`);
}

async function phaseGithub(version, prereleaseTag, assets) {
  log(`Phase 9/9: publish to GitHub`);
  const tag = `v${version}-${prereleaseTag}`;
  const isPrerelease = prereleaseTag.startsWith('alpha.');

  // Read the CHANGELOG section for this version to use as the release body.
  const changelog = readFileSync(join(REPO_ROOT, 'CHANGELOG.md'), 'utf8');
  const sectionRe = new RegExp(`(## \\[${version}-${prereleaseTag}\\][\\s\\S]*?)(?=\\n## \\[|$)`);
  const sectionMatch = changelog.match(sectionRe);
  let body = sectionMatch ? sectionMatch[1].trim() : `Release ${tag}`;
  body = body.replace(/^## \[.*?\][^\n]*\n+/, '');
  body = body.replace(/\n+---\s*$/, '').trim();

  // Wait for the Gitea push mirror to sync the tag to GitHub.
  // Poll up to 60s — the mirror fires on push, so it's usually fast.
  const tagUrl = `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/ref/tags/${tag}`;
  let tagSynced = false;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      await github('GET', tagUrl);
      tagSynced = true;
      break;
    } catch {
      if (attempt === 0) log('waiting for tag to sync to GitHub...');
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  if (!tagSynced) {
    warn(`tag ${tag} not yet on GitHub — mirror may be delayed. Skipping GitHub release.`);
    return;
  }
  ok(`tag ${tag} exists on GitHub`);

  // Does the release already exist?
  let release = null;
  try {
    release = await github('GET', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tags/${tag}`);
    ok(`GitHub release ${tag} already exists (id ${release.id})`);
  } catch (e) {
    if (!String(e).includes('404')) throw e;
  }

  if (!release) {
    if (DRY_RUN) { log(`[dry-run] would create GitHub release ${tag}`); return; }
    release = await github('POST', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases`, {
      body: {
        tag_name: tag,
        target_commitish: 'main',
        name: tag,
        body,
        draft: false,
        prerelease: isPrerelease,
      },
    });
    ok(`created GitHub release ${tag} (id ${release.id})`);
  }

  // Upload only the Setup.exe to GitHub (skip portable zip to save upload time).
  const githubAssets = assets.filter(a => a.name.toLowerCase().includes('setup'));
  const existing = new Set((release.assets || []).map(a => a.name));
  for (const asset of githubAssets) {
    if (existing.has(asset.name)) {
      ok(`GitHub asset ${asset.name} already uploaded`);
      continue;
    }
    if (DRY_RUN) { log(`[dry-run] would upload ${asset.name} to GitHub`); continue; }
    log(`uploading ${asset.name} to GitHub...`);
    const ghUploadUrl = `https://uploads.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/${release.id}/assets?name=${encodeURIComponent(asset.name)}`;
    curlUpload(asset.path, ghUploadUrl, `Authorization: Bearer ${readGithubToken()}`);
    ok(`uploaded ${asset.name} to GitHub`);
  }

  console.log(`\n\x1b[32m✓\x1b[0m GitHub release published: https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tag/${tag}\n`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Parse prerelease tag from positional arg (alpha.N or beta.N)
  let prereleaseTag = args.find(a => /^(alpha|beta)\.\d+$/.test(a));
  if (!prereleaseTag && NEXT) {
    // Detect channel from args or default to alpha
    const channel = args.find(a => /^(alpha|beta)$/.test(a)) || 'alpha';
    const n = await nextPrereleaseNumber(channel);
    prereleaseTag = `${channel}.${n}`;
    log(`auto-picked prerelease tag: ${prereleaseTag}`);
  }
  if (!prereleaseTag) die('Usage: node scripts/release.mjs <alpha|beta>.N [--resume] [--dry-run]   (or: --next)');

  // Determine target package version. If we're resuming an in-flight release
  // where package.json is already bumped, use that. Otherwise bump patch.
  const cur = currentPackageVersion();
  const tagForCur = `v${cur}-${prereleaseTag}`;
  const tagExists = sh(`git tag -l ${tagForCur}`);
  let targetVersion;
  if (tagExists) {
    targetVersion = cur;
    log(`resuming: tag ${tagForCur} already exists, using current package version ${cur}`);
  } else if (RESUME) {
    targetVersion = cur;
    log(`resuming: using current package version ${cur} (${prereleaseTag})`);
  } else {
    targetVersion = bumpPatch(cur);
    log(`current package version: ${cur} → target: ${targetVersion} (${prereleaseTag})`);
  }

  phasePreflight();
  phaseVersion(targetVersion);
  phaseChangelog(targetVersion, prereleaseTag);
  const tag = phaseCommitTag(targetVersion, prereleaseTag);
  phasePush(tag);
  const builtPaths = phaseBuild(targetVersion);
  const assets = phaseAssets(targetVersion, builtPaths);
  await phasePublish(targetVersion, prereleaseTag, assets);
  await phaseGithub(targetVersion, prereleaseTag, assets);
}

main().catch(e => die(e.stack || String(e)));
