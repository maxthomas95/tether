#!/usr/bin/env node
// Estimate SonarQube Cloud's "coverage on new code" for this branch from
// coverage/lcov.info (run `npm run test:coverage` first). Only lines added or
// modified since the merge base count, using Sonar's formula:
//   (covered lines + covered conditions) / (coverable lines + conditions)
//
//   npm run coverage:changed            # compare with main
//   npm run coverage:changed -- github/main
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LCOV = path.join(REPO_ROOT, 'coverage', 'lcov.info');
const THRESHOLD = 80; // Sonar way: coverage on new code
const base = process.argv[2] || 'main';

function git(args) {
  const r = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); // NOSONAR(javascript:S4036) developer tool; git comes from the user's PATH
  if (r.status !== 0) {
    console.error(`git ${args.join(' ')} failed:\n${r.stderr || r.error?.message || ''}`);
    process.exit(2);
  }
  return r.stdout;
}

const toPosix = file => file.split(path.sep).join('/');

// Mirrors vitest's coverage scope and sonar.coverage.exclusions for src/.
function inCoverageScope(file) {
  if (!file.startsWith('src/')) return false;
  if (!file.endsWith('.ts') && !file.endsWith('.tsx')) return false;
  if (file.endsWith('.d.ts') || file.endsWith('.test.ts') || file.endsWith('.test-helper.ts')) return false;
  return !file.includes('/__mocks__/') && file !== 'src/renderer/index.tsx';
}

function changedLines(mergeBase) {
  const byFile = new Map();
  let current = null;
  for (const line of git(['diff', '-U0', '--no-color', '--diff-filter=ACMR', mergeBase, '--', 'src']).split('\n')) {
    if (line.startsWith('+++ ')) {
      const name = line.slice(4).trim();
      current = name.startsWith('b/') && inCoverageScope(name.slice(2)) ? name.slice(2) : null;
      if (current && !byFile.has(current)) byFile.set(current, new Set());
    } else if (current && line.startsWith('@@')) {
      const plus = line.split(' ').find(part => part.startsWith('+'));
      const [start, count = '1'] = plus.slice(1).split(',');
      for (let n = 0; n < Number(count); n++) byFile.get(current).add(Number(start) + n);
    }
  }
  for (const file of git(['ls-files', '--others', '--exclude-standard', '--', 'src']).split('\n')) {
    const name = file.trim();
    if (!inCoverageScope(name)) continue;
    const count = readFileSync(path.join(REPO_ROOT, name), 'utf8').split('\n').length;
    byFile.set(name, new Set(Array.from({ length: count }, (_, i) => i + 1)));
  }
  return byFile;
}

function readLcov() {
  const files = new Map();
  let record = null;
  for (const raw of readFileSync(LCOV, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      const sf = line.slice(3);
      const rel = toPosix(path.isAbsolute(sf) ? path.relative(REPO_ROOT, sf) : sf);
      record = { lines: new Map(), branches: new Map() };
      files.set(rel, record);
    } else if (record && line.startsWith('DA:')) {
      const [n, hits] = line.slice(3).split(',');
      record.lines.set(Number(n), Number(hits) > 0);
    } else if (record && line.startsWith('BRDA:')) {
      const [n, , , taken] = line.slice(5).split(',');
      const entry = record.branches.get(Number(n)) ?? { total: 0, covered: 0 };
      entry.total += 1;
      if (taken !== '-' && Number(taken) > 0) entry.covered += 1;
      record.branches.set(Number(n), entry);
    } else if (line === 'end_of_record') {
      record = null;
    }
  }
  return files;
}

if (!existsSync(LCOV)) {
  console.error('coverage/lcov.info not found. Run `npm run test:coverage` first.');
  process.exit(2);
}

const mergeBase = git(['merge-base', 'HEAD', base]).trim();
const changed = changedLines(mergeBase);
const lcov = readLcov();
const rows = [];
let toCover = 0;
let covered = 0;

for (const [file, lines] of [...changed].sort(([a], [b]) => a.localeCompare(b))) {
  const record = lcov.get(file);
  if (!record) {
    console.warn(`warning: ${file} is missing from lcov.info; is the coverage report stale?`);
    continue;
  }
  let fileTotal = 0;
  let fileCovered = 0;
  const missed = [];
  for (const n of lines) {
    if (record.lines.has(n)) {
      fileTotal += 1;
      if (record.lines.get(n)) fileCovered += 1;
      else missed.push(n);
    }
    const branch = record.branches.get(n);
    if (branch) {
      fileTotal += branch.total;
      fileCovered += branch.covered;
    }
  }
  if (fileTotal === 0) continue;
  toCover += fileTotal;
  covered += fileCovered;
  rows.push({ file, pct: (100 * fileCovered) / fileTotal, missed });
}

if (toCover === 0) {
  console.log(`No coverable changed lines since ${base}.`);
  process.exit(0);
}

for (const { file, pct, missed } of rows) {
  const lines = missed.length ? `  uncovered: ${compactRanges(missed)}` : '';
  console.log(`${pct.toFixed(1).padStart(5)}%  ${file}${lines}`);
}
const total = (100 * covered) / toCover;
console.log(`\nNew-code coverage since ${base}: ${total.toFixed(1)}% (${covered}/${toCover}; gate ${THRESHOLD}%)`);
process.exit(total >= THRESHOLD ? 0 : 1);

function compactRanges(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(i === j ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`);
    i = j;
  }
  return parts.join(',');
}
