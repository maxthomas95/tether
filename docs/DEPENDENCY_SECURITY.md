# Dependency security checks

Run `npm run audit:security`, `npm audit --omit=dev --audit-level=high`, and
`npm --prefix mcp-servers/tether-helm audit --audit-level=high` before release.
The runtime and Helm checks reject all high or critical findings.

## Temporary braces backport

As of 2026-10-04, npm has no fixed release for
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
Our build dependencies still resolve `braces@3.0.3`. `patch-package` applies
`patches/braces+3.0.3.patch` during postinstall, backporting the nesting limits
and AST cycle protection from
[upstream PR 72](https://github.com/micromatch/braces/pull/72), commit
`28d440b5dd449dbf1fe6f3506cf94ecca4d02660`. Unrelated upstream parser changes
are excluded. Parsing and recursive AST operations reject depths above 100.

The root audit still reports this advisory against the published version,
including inherited findings in its build dependency chain. The CI check
accepts only this specific advisory in the seven reviewed build packages,
after verifying installed file hashes and the lockfile's single dev-only
`braces@3.0.3` installation. Regression tests cover deep string and AST inputs,
cycles, normal globs, quoting and escaping. Other high/critical advisories,
runtime exposure, changed versions, missing patches, incomplete audit reports
and an expired review all fail the check.

This review expires **2026-11-04 UTC**. Replace the backport with a fixed
published dependency as soon as one is available, then remove the exception,
patch and integrity manifest. Do not extend the deadline without reviewing
upstream status and exposure again.
