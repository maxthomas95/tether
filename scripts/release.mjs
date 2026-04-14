#!/usr/bin/env node
// Tether release script — see RELEASE.md for usage and conventions.
//
// Phases (each is a no-op if its work is already done, so the script is
// safe to re-run after a partial failure):
//   1. preflight      — branch is main, tree clean, up to date with github
//   2. release-branch — create/checkout release/v{version}-{prerelease}
//   3. version        — bump package.json on the release branch
//   4. changelog      — ensure a CHANGELOG.md section exists for the new version
//   5. commit-push    — commit bump+changelog, push release branch to github
//   6. pr             — open PR (or reuse existing), enable auto-merge (squash)
//   7. wait-merge     — poll until the PR is merged into main
//   8. tag            — fast-forward local main, tag the merged commit, push tag
//   9. build          — npm run make
//   10. assets        — locate Setup.exe and portable zip, rename to convention
//   11. publish       — create GitHub release + upload assets
//
// Usage:
//   node scripts/release.mjs alpha.N            # cut a new alpha (patch bump)
//   node scripts/release.mjs beta.N             # cut a new beta  (patch bump)
//   node scripts/release.mjs beta.1 --minor     # minor bump (e.g. 0.2.3 → 0.3.0)
//   node scripts/release.mjs alpha.N --resume   # skip phases that are already done
//   node scripts/release.mjs alpha.N --dry-run  # print what would happen
//   node scripts/release.mjs --next             # auto-pick next prerelease number
//
// Environment:
//   GITHUB_TOKEN_FILE  override the default GitHub token path
//                      (default: ~/.tether/github-token)

import { execSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { argv, exit, platform } from 'node:process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

// ─── Config ──────────────────────────────────────────────────────────────────

const GITHUB_OWNER = 'maxthomas95';
const GITHUB_REPO  = 'tether';
const GITHUB_REMOTE = 'github';
const GITHUB_BASE  = 'https://api.github.com';
const DEFAULT_GITHUB_TOKEN_FILE = join(process.env.HOME || process.env.USERPROFILE, '.tether', 'github-token');

// Auto-merge waits for required status checks. Ceiling keeps us from hanging
// forever if checks stall or the PR needs manual intervention.
const MERGE_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
const MERGE_WAIT_POLL_MS    = 15 * 1000;

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// ─── Utilities ───────────────────────────────────────────────────────────────

const args = argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const RESUME  = args.includes('--resume');
const NEXT    = args.includes('--next');
const MINOR   = args.includes('--minor');

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
  ], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) {
    const stderr = r.stderr?.toString().trim() || '';
    throw new Error(`curl upload failed (exit ${r.status}): ${stderr}`);
  }
}

function readJSON(path)  { return JSON.parse(readFileSync(path, 'utf8')); }
function writeJSON(path, obj) { writeFileSync(path, JSON.stringify(obj, null, 2) + '\n'); }

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

function gh(args, opts = {}) {
  if (DRY_RUN && opts.mutating) {
    log(`[dry-run] would run: gh ${args.join(' ')}`);
    return '';
  }
  // Do NOT use shell: true — on Windows it collapses args into a cmd.exe string
  // and splits values with spaces (e.g. --title "Release v0.3.0-beta.1").
  const r = spawnSync('gh', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  if (r.status !== 0) {
    const stderr = r.stderr?.toString().trim() || '';
    throw new Error(`gh ${args.join(' ')} failed (exit ${r.status}): ${stderr}`);
  }
  return (r.stdout || '').trim();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Version + prerelease resolution ─────────────────────────────────────────

function currentPackageVersion() {
  return readJSON(join(REPO_ROOT, 'package.json')).version;
}

function bumpPatch(version) {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) die(`Cannot parse version: ${version}`);
  return `${m[1]}.${m[2]}.${parseInt(m[3], 10) + 1}`;
}

function bumpMinor(version) {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) die(`Cannot parse version: ${version}`);
  return `${m[1]}.${parseInt(m[2], 10) + 1}.0`;
}

async function nextPrereleaseNumber(channel) {
  const releases = await github('GET', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases`, { query: { per_page: 100 } });
  let max = 0;
  for (const r of releases) {
    const m = r.tag_name.match(new RegExp(`-${channel}\\.(\\d+)$`));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

function releaseBranchName(version, prereleaseTag) {
  return `release/v${version}-${prereleaseTag}`;
}

// ─── Phases ──────────────────────────────────────────────────────────────────

function phasePreflight() {
  log('Phase 1/11: preflight');
  const branch = sh('git rev-parse --abbrev-ref HEAD');
  if (!RESUME && branch !== 'main') die(`Not on main (currently on ${branch})`);

  const status = sh('git status --porcelain');
  if (status) {
    if (RESUME) warn(`Working tree not clean (--resume mode, continuing):\n${status}`);
    else die(`Working tree not clean:\n${status}`);
  }

  sh(`git fetch ${GITHUB_REMOTE} main`);
  const local  = sh('git rev-parse main');
  const remote = sh(`git rev-parse ${GITHUB_REMOTE}/main`);
  if (local !== remote) {
    if (RESUME) warn(`Local main differs from ${GITHUB_REMOTE}/main (--resume mode, continuing)`);
    else die(`Local main (${local.slice(0,7)}) differs from ${GITHUB_REMOTE}/main (${remote.slice(0,7)}). Pull or push first.`);
  }
  ok('preflight passed');
}

function phaseReleaseBranch(version, prereleaseTag) {
  log(`Phase 2/11: release branch`);
  const branch = releaseBranchName(version, prereleaseTag);
  const currentBranch = sh('git rev-parse --abbrev-ref HEAD');
  const branchExists = sh(`git rev-parse --verify --quiet ${branch} || true`);

  if (currentBranch === branch) {
    ok(`already on ${branch}`);
    return branch;
  }
  if (branchExists) {
    sh(`git checkout ${branch}`, { mutating: true });
    ok(`checked out existing ${branch}`);
    return branch;
  }
  sh(`git checkout -b ${branch} main`, { mutating: true });
  ok(`created ${branch} from main`);
  return branch;
}

function phaseVersion(targetVersion) {
  log(`Phase 3/11: version → ${targetVersion}`);
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
  log(`Phase 4/11: changelog`);
  const path = join(REPO_ROOT, 'CHANGELOG.md');
  const content = readFileSync(path, 'utf8');
  const heading = `## [${version}-${prereleaseTag}]`;
  if (content.includes(heading)) {
    ok(`CHANGELOG.md already has section for ${version}-${prereleaseTag}`);
    return;
  }
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
  warn(`Drafted CHANGELOG.md section for ${version}-${prereleaseTag}. Edit it before the PR merges if needed.`);
}

function phaseCommitPush(version, prereleaseTag, branch) {
  log(`Phase 5/11: commit + push release branch`);

  const releaseFileDiff = sh('git diff --name-only HEAD -- package.json CHANGELOG.md');
  if (releaseFileDiff) {
    sh('git add package.json CHANGELOG.md', { mutating: true });
    const msg = `Release v${version}-${prereleaseTag}`;
    sh(`git commit -m "${msg}"`, { mutating: true });
    ok(`committed bump to ${branch}`);
  } else {
    ok(`no release-file changes to commit (already committed or no diff)`);
  }

  let ahead = '0';
  try {
    ahead = sh(`git rev-list ${GITHUB_REMOTE}/${branch}..${branch} --count`);
  } catch {
    // Remote branch doesn't exist yet — everything is "ahead".
    ahead = sh(`git rev-list ${branch} --count`);
  }
  if (parseInt(ahead, 10) > 0) {
    sh(`git push -u ${GITHUB_REMOTE} ${branch}`, { mutating: true });
    ok(`pushed ${branch} to ${GITHUB_REMOTE}`);
  } else {
    ok(`${branch} already up to date on ${GITHUB_REMOTE}`);
  }
}

async function phasePR(version, prereleaseTag, branch) {
  log(`Phase 6/11: pull request`);
  const title = `Release v${version}-${prereleaseTag}`;

  const existing = JSON.parse(gh(['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,state,url,mergedAt']) || '[]');
  let pr = existing[0];

  if (pr && pr.state === 'MERGED') {
    ok(`PR #${pr.number} already merged`);
    return pr;
  }

  if (!pr) {
    const body = `Automated release PR for \`v${version}-${prereleaseTag}\`.\n\nSee CHANGELOG.md for details.`;
    if (DRY_RUN) {
      log(`[dry-run] would create PR: ${title}`);
      return { number: 0, state: 'OPEN' };
    }
    gh(['pr', 'create', '--base', 'main', '--head', branch, '--title', title, '--body', body], { mutating: true });
    const created = JSON.parse(gh(['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,state,url']));
    pr = created[0];
    ok(`opened PR #${pr.number}: ${pr.url}`);
  } else {
    ok(`PR #${pr.number} already open`);
  }

  if (!DRY_RUN) {
    try {
      gh(['pr', 'merge', String(pr.number), '--squash', '--auto', '--delete-branch'], { mutating: true });
      ok(`auto-merge enabled on PR #${pr.number}`);
    } catch (e) {
      // Auto-merge may not be enabled on the repo, or the PR may already be mergeable — try a direct squash-merge.
      try {
        gh(['pr', 'merge', String(pr.number), '--squash', '--delete-branch'], { mutating: true });
        ok(`squash-merged PR #${pr.number} directly`);
      } catch (e2) {
        warn(`merge commands failed (PR may need manual attention): ${String(e2).split('\n')[0]}`);
      }
    }
  }
  return pr;
}

async function phaseWaitMerge(pr) {
  log(`Phase 7/11: wait for merge`);
  if (DRY_RUN) { ok('skip wait (dry-run)'); return; }
  if (pr.state === 'MERGED' || pr.mergedAt) { ok(`PR #${pr.number} already merged`); return; }

  const deadline = Date.now() + MERGE_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const view = JSON.parse(gh(['pr', 'view', String(pr.number), '--json', 'state,mergedAt,mergeCommit']));
    if (view.state === 'MERGED') { ok(`PR #${pr.number} merged`); return; }
    if (view.state === 'CLOSED') die(`PR #${pr.number} was closed without merging`);
    await sleep(MERGE_WAIT_POLL_MS);
    log(`  ...still waiting (state: ${view.state})`);
  }
  die(`Timed out after ${MERGE_WAIT_TIMEOUT_MS / 60000} min waiting for PR #${pr.number}. Re-run with --resume once it merges.`);
}

function phaseTag(version, prereleaseTag) {
  log(`Phase 8/11: tag main`);
  const tag = `v${version}-${prereleaseTag}`;

  sh(`git fetch ${GITHUB_REMOTE} main`);
  const currentBranch = sh('git rev-parse --abbrev-ref HEAD');
  if (currentBranch !== 'main') {
    sh('git checkout main', { mutating: true });
  }
  sh(`git merge --ff-only ${GITHUB_REMOTE}/main`, { mutating: true });

  const tagExists = sh(`git tag -l ${tag}`);
  if (!tagExists) {
    sh(`git tag ${tag}`, { mutating: true });
    ok(`tagged ${tag}`);
  } else {
    ok(`tag ${tag} already exists locally`);
  }

  const remoteTag = sh(`git ls-remote ${GITHUB_REMOTE} refs/tags/${tag}`);
  if (!remoteTag) {
    sh(`git push ${GITHUB_REMOTE} ${tag}`, { mutating: true });
    ok(`pushed tag ${tag} to ${GITHUB_REMOTE}`);
  } else {
    ok(`tag ${tag} already on ${GITHUB_REMOTE}`);
  }
  return tag;
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
  log(`Phase 9/11: build (npm run make)`);
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
  log(`Phase 10/11: assets`);
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

async function phasePublishGithub(version, prereleaseTag, assets) {
  log(`Phase 11/11: publish to GitHub`);
  const tag = `v${version}-${prereleaseTag}`;
  const isPrerelease = prereleaseTag.startsWith('alpha.') || prereleaseTag.startsWith('beta.');

  const changelog = readFileSync(join(REPO_ROOT, 'CHANGELOG.md'), 'utf8');
  const sectionRe = new RegExp(`(## \\[${version}-${prereleaseTag}\\][\\s\\S]*?)(?=\\n## \\[|$)`);
  const sectionMatch = changelog.match(sectionRe);
  let body = sectionMatch ? sectionMatch[1].trim() : `Release ${tag}`;
  body = body.replace(/^## \[.*?\][^\n]*\n+/, '');
  body = body.replace(/\n+---\s*$/, '').trim();

  const tagUrl = `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/ref/tags/${tag}`;
  try {
    await github('GET', tagUrl);
  } catch {
    die(`tag ${tag} not found on GitHub — phaseTag should have pushed it`);
  }
  ok(`tag ${tag} exists on GitHub`);

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

  const existing = new Set((release.assets || []).map(a => a.name));
  for (const asset of assets) {
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
  let prereleaseTag = args.find(a => /^(alpha|beta)\.\d+$/.test(a));
  if (!prereleaseTag && NEXT) {
    const channel = args.find(a => /^(alpha|beta)$/.test(a)) || 'alpha';
    const n = await nextPrereleaseNumber(channel);
    prereleaseTag = `${channel}.${n}`;
    log(`auto-picked prerelease tag: ${prereleaseTag}`);
  }
  if (!prereleaseTag) die('Usage: node scripts/release.mjs <alpha|beta>.N [--minor] [--resume] [--dry-run]   (or: --next)');

  // --resume reuses current pkg version; --minor bumps minor; default bumps patch.
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
  } else if (MINOR) {
    targetVersion = bumpMinor(cur);
    log(`current package version: ${cur} → target: ${targetVersion} (${prereleaseTag}, minor bump)`);
  } else {
    targetVersion = bumpPatch(cur);
    log(`current package version: ${cur} → target: ${targetVersion} (${prereleaseTag})`);
  }

  phasePreflight();
  const branch = phaseReleaseBranch(targetVersion, prereleaseTag);
  phaseVersion(targetVersion);
  phaseChangelog(targetVersion, prereleaseTag);
  phaseCommitPush(targetVersion, prereleaseTag, branch);
  const pr = await phasePR(targetVersion, prereleaseTag, branch);
  await phaseWaitMerge(pr);
  phaseTag(targetVersion, prereleaseTag);
  const builtPaths = phaseBuild(targetVersion);
  const assets = phaseAssets(targetVersion, builtPaths);
  await phasePublishGithub(targetVersion, prereleaseTag, assets);
}

main().catch(e => die(e.stack || String(e)));
