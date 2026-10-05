import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { evaluateAudit, verifyBracesPatch } from './audit-security.mjs';

const require = createRequire(import.meta.url);
const braces = require('braces');
const advisory = { url: 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm', dependency: 'braces', severity: 'high' };
const issue = (name, via) => ({ name, severity: 'high', via, nodes: [`node_modules/${name}`] });
const report = () => ({ auditReportVersion: 2, metadata: {}, vulnerabilities: {
  braces: issue('braces', [advisory]), micromatch: issue('micromatch', ['braces']),
} });
const policy = () => ({ expires: '2026-11-04T00:00:00Z', now: new Date('2026-10-04'), lock: { packages: {
  'node_modules/braces': { version: '3.0.3', dev: true }, 'node_modules/micromatch': { dev: true },
} } });

test('accepts only the reviewed dev advisory and its inherited entries', () => {
  assert.deepEqual(evaluateAudit(report(), policy()), { blocked: [], mitigated: ['braces', 'micromatch'] });
});

test('blocks a second advisory inherited through the same dependency', () => {
  const audit = report();
  audit.vulnerabilities.braces.via.push({ ...advisory, url: 'https://github.com/advisories/GHSA-other' });
  assert.deepEqual(evaluateAudit(audit, policy()).blocked, ['braces', 'micromatch']);
});

test('blocks critical severity, runtime exposure, version drift and expired review', () => {
  const critical = report();
  critical.vulnerabilities.braces.severity = 'critical';
  assert.ok(evaluateAudit(critical, policy()).blocked.includes('braces'));
  const runtime = policy();
  runtime.lock.packages['node_modules/micromatch'].dev = false;
  assert.deepEqual(evaluateAudit(report(), runtime).blocked, ['micromatch']);
  const drift = policy();
  drift.lock.packages['node_modules/braces'].version = '3.0.2';
  assert.equal(evaluateAudit(report(), drift).blocked.length, 2);
  assert.equal(evaluateAudit(report(), { ...policy(), now: new Date('2026-11-04') }).blocked.length, 2);
});

test('rejects incomplete reports and dependency cycles', () => {
  assert.throws(() => evaluateAudit({ error: { code: 'NETWORK' } }, policy()), /complete report/);
  const audit = report();
  audit.vulnerabilities.braces.via = ['micromatch'];
  assert.equal(evaluateAudit(audit, policy()).blocked.length, 2);
});

test('requires the exact installed mitigation', () => {
  assert.doesNotThrow(() => verifyBracesPatch());
  const integrity = JSON.parse(readFileSync(new URL('./braces-patch-integrity.json', import.meta.url), 'utf8'));
  integrity.sha256['node_modules/braces/lib/parse.js'] = 'missing';
  assert.throws(() => verifyBracesPatch({ integrity }), /integrity mismatch/);
  integrity.sha256 = {};
  assert.throws(() => verifyBracesPatch({ integrity }), /manifest is incomplete/);
});

for (const [open, close] of [['{', '}'], ['(', ')']]) {
  for (const method of ['parse', 'compile', 'expand', 'stringify']) {
    test(`${method} bounds nested ${open}${close} strings before stack exhaustion`, () => {
      assert.doesNotThrow(() => braces[method](open.repeat(100) + 'a' + close.repeat(100)));
      for (const depth of [101, 4000]) {
        assert.throws(() => braces[method](open.repeat(depth) + 'a' + close.repeat(depth)), /exceeds max depth/);
      }
      assert.throws(() => braces[method](open.repeat(2) + 'a' + close.repeat(2), { maxDepth: 1.5 }), /exceeds max depth/);
    });
  }
}

for (const method of ['compile', 'expand', 'stringify']) {
  test(`${method} bounds caller-supplied ASTs and cyclic child nodes`, () => {
    let ast = { type: 'text', value: 'a' };
    for (let i = 0; i < 101; i++) ast = { type: 'paren', nodes: [ast] };
    assert.throws(() => braces[method]({ type: 'root', nodes: [ast] }), /exceeds max depth/);
    const cycle = { type: 'root', nodes: [] };
    cycle.nodes.push(cycle);
    assert.throws(() => braces[method](cycle), /exceeds max depth/);
  });
}

test('preserves ordinary glob expansion, quoting and escaping', () => {
  assert.deepEqual(braces.expand('src/{main,renderer}/**/*.{ts,tsx}'), [
    'src/main/**/*.ts', 'src/main/**/*.tsx', 'src/renderer/**/*.ts', 'src/renderer/**/*.tsx',
  ]);
  assert.equal(braces.stringify(braces.parse('{a,{b,c}}'), { escapeInvalid: true }), '{a,{b,c}}');
  assert.equal(braces.stringify(braces.parse('"' + '{'.repeat(200) + '"')), '{'.repeat(200));
  assert.doesNotThrow(() => braces.parse('\\{'.repeat(200)));
  assert.throws(() => braces.parse('('.repeat(51) + '{'.repeat(50)), /exceeds max depth/);
});

test('rejects cyclic AST parent chains during expansion', () => {
  const node = { type: 'paren', nodes: [] };
  node.parent = node;
  assert.throws(() => braces.expand({ type: 'root', nodes: [node] }), /parent chain contains a cycle/);
});
