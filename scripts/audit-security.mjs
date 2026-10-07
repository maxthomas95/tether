import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const advisory = 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm';
const affectedBuildPackages = new Set([
  'braces', 'micromatch', 'fast-glob', 'find-yarn-workspace-root',
  'patch-package', '@electron-forge/core', '@electron-forge/cli',
]);
const patchedFiles = [
  'patches/braces+3.0.3.patch',
  ...['parse', 'compile', 'expand', 'stringify', 'constants'].map(name => `node_modules/braces/lib/${name}.js`),
];

function isReviewedAdvisory(name, via, issue, lock) {
  return name === 'braces' && via.url === advisory && via.dependency === 'braces'
    && via.severity === 'high' && issue.nodes.every(path => lock.packages[path]?.version === '3.0.3');
}

function isBelowAuditThreshold(name, issues, lock, seen) {
  const issue = issues[name];
  if (seen.has(name) || !['info', 'low', 'moderate'].includes(issue?.severity)
    || !issue.via?.length || !issue.nodes?.length
    || issue.nodes.some(path => lock.packages[path]?.dev !== true)) return false;
  const next = new Set([...seen, name]);
  // Inspect the whole path: a malformed moderate entry must not hide a new
  // high/critical advisory, missing dependency, or dependency cycle.
  return issue.via.every(via => typeof via === 'string'
    ? isBelowAuditThreshold(via, issues, lock, next)
    : ['info', 'low', 'moderate'].includes(via.severity));
}

function isCoveredBuildIssue(name, issues, lock, seen = new Set()) {
  const issue = issues[name];
  if (seen.has(name) || !affectedBuildPackages.has(name) || issue?.severity !== 'high' || !issue.via?.length
    || !issue.nodes?.length || issue.nodes.some(path => lock.packages[path]?.dev !== true)) return false;
  const next = new Set([...seen, name]);
  return issue.via.every(via => typeof via === 'string'
    ? isBelowAuditThreshold(via, issues, lock, next) || isCoveredBuildIssue(via, issues, lock, next)
    : isReviewedAdvisory(name, via, issue, lock));
}

export function verifyBracesPatch({ repoRoot = root, integrity } = {}) {
  const manifest = integrity ?? JSON.parse(readFileSync(resolve(repoRoot, 'scripts/braces-patch-integrity.json'), 'utf8'));
  if (Object.keys(manifest.sha256).length !== patchedFiles.length
    || patchedFiles.some(file => typeof manifest.sha256[file] !== 'string')) {
    throw new Error('Security patch integrity manifest is incomplete');
  }
  const lock = JSON.parse(readFileSync(resolve(repoRoot, 'package-lock.json'), 'utf8'));
  const installations = Object.entries(lock.packages).filter(([path]) => path.endsWith('/braces'));
  if (installations.length !== 1 || installations[0][0] !== 'node_modules/braces'
    || installations[0][1].version !== '3.0.3' || installations[0][1].dev !== true) {
    throw new Error('braces mitigation requires exactly one dev-only installation of 3.0.3');
  }
  for (const [file, expected] of Object.entries(manifest.sha256)) {
    const contents = readFileSync(resolve(repoRoot, file), 'utf8').replaceAll('\r\n', '\n');
    const actual = createHash('sha256').update(contents).digest('hex');
    if (actual !== expected) throw new Error(`Security patch integrity mismatch: ${file}`);
  }
  return { lock, expires: manifest.expires };
}

export function evaluateAudit(report, { lock, expires, now = new Date() }) {
  if (report?.auditReportVersion !== 2 || !report.vulnerabilities || !report.metadata || report.error) {
    throw new Error('npm audit did not return a complete report');
  }
  const issues = report.vulnerabilities;
  const blocked = [];
  const mitigated = [];
  const inReviewPeriod = now.getTime() < Date.parse(expires);
  for (const [name, issue] of Object.entries(issues)) {
    if (issue.severity !== 'high' && issue.severity !== 'critical') continue;
    if (issue.severity === 'high' && inReviewPeriod && isCoveredBuildIssue(name, issues, lock)) mitigated.push(name);
    else blocked.push(name);
  }
  return { blocked, mitigated };
}

function main() {
  const verified = verifyBracesPatch();
  // npm supplies its CLI entry point when this is run through audit:security.
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('Run this check with npm run audit:security');
  const result = spawnSync(process.execPath, [npmCli, 'audit', '--json'], {
    cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || ![0, 1].includes(result.status)) throw new Error('npm audit failed to complete');
  const { blocked, mitigated } = evaluateAudit(JSON.parse(result.stdout), verified);
  if (blocked.length) throw new Error(`Unmitigated high/critical dependencies: ${blocked.join(', ')}`);
  if (mitigated.length) {
    console.log(`Verified braces depth-limit backport: ${mitigated.length} build-only audit entries share ${advisory}`);
    console.log(`Review expires ${verified.expires}; runtime and Helm audits remain strict.`);
  } else console.log('No high/critical dependencies reported.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
