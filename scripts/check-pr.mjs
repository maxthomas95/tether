#!/usr/bin/env node
// Pre-PR check: the local stand-ins for CI's SonarQube Cloud gate. Every step
// runs even if an earlier one fails, so one pass shows everything to fix.
//
//   npm run check:pr                 # compare with main
//   npm run check:pr -- github/main
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.argv[2] || 'main';
const bin = name => path.join(REPO_ROOT, 'node_modules', name);

const steps = [
  ['typecheck', [bin('typescript/bin/tsc'), '--noEmit']],
  ['lint (changed files)', [path.join(REPO_ROOT, 'scripts', 'lint-changed.mjs'), base]],
  // Report coverage even when a test fails, so the coverage step still runs.
  ['tests with coverage', [bin('vitest/vitest.mjs'), 'run', '--coverage', '--coverage.reportOnFailure']],
  ['new-code coverage', [path.join(REPO_ROOT, 'scripts', 'coverage-changed.mjs'), base]],
];

const results = [];
for (const [name, args] of steps) {
  console.log(`\n=== ${name} ===`);
  const r = spawnSync(process.execPath, args, { cwd: REPO_ROOT, stdio: 'inherit' });
  results.push([name, r.status === 0]);
}

console.log('\n=== check:pr summary ===');
for (const [name, ok] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
