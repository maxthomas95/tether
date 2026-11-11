#!/usr/bin/env node
// Lint only the src/ TypeScript files this branch changes, as a local
// stand-in for SonarQube Cloud's new-code analysis. Includes committed,
// staged, unstaged and untracked changes relative to the merge base.
//
//   npm run lint:changed            # compare with main
//   npm run lint:changed -- github/main
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.argv[2] || 'main';

function git(args) {
  const r = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }); // NOSONAR(javascript:S4036) developer tool; git comes from the user's PATH
  if (r.status !== 0) {
    console.error(`git ${args.join(' ')} failed:\n${r.stderr || r.error?.message || ''}`);
    process.exit(2);
  }
  return r.stdout.split('\n').map(line => line.trim()).filter(Boolean);
}

const [mergeBase] = git(['merge-base', 'HEAD', base]);
const changed = new Set([
  ...git(['diff', '--name-only', '--diff-filter=ACMR', mergeBase]),
  ...git(['ls-files', '--others', '--exclude-standard']),
]);
const files = [...changed]
  .filter(file => file.startsWith('src/') && (file.endsWith('.ts') || file.endsWith('.tsx')))
  .sort((a, b) => a.localeCompare(b));

if (files.length === 0) {
  console.log(`No changed src/**/*.{ts,tsx} files since ${base}.`);
  process.exit(0);
}

console.log(`Linting ${files.length} changed file(s) since ${base}...`);
const eslintPkg = createRequire(import.meta.url).resolve('eslint/package.json');
const eslintBin = path.join(path.dirname(eslintPkg), 'bin', 'eslint.js');
const r = spawnSync(process.execPath, [eslintBin, ...files], { cwd: REPO_ROOT, stdio: 'inherit' });
process.exit(r.status ?? 1);
