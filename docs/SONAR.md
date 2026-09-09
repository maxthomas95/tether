# SonarQube Cloud and coverage

CI runs `npm run test:coverage` in the existing `tests` job, then uploads the
`coverage` artifact (LCOV plus browsable HTML, retained for seven days). The
separate `SonarQube scan` job imports that report into the existing
`maxthomas95_tether` project. It does not run the tests again.

Run `npm run test:coverage` locally and open `coverage/index.html` to inspect
coverage. The suite includes untested application TS/TSX files in its baseline;
tests, test helpers, mocks, and declaration files are excluded. Build scripts and the
Helm server are outside this coverage suite but remain statically analyzed.
There is no local coverage threshold. Keep the coverage provider version aligned
with Vitest when upgrading them.

## Release baseline and gate policy

CI supplies `sonar.projectVersion` from the checked-out `package.json` version.
Keep Sonar's new-code definition on **Previous version**: the first main-branch
analysis for a release version starts that version's new-code period. Beta
builds sharing the package version stay in the same period. PR analysis still
compares the PR with its target branch.

The initial versioned scan replaces the old `not provided` period, which began
on April 14, 2026. Existing findings remain visible under overall code; changing
the version is not an issue disposition. Advance it through the normal release
process, not on every CI build or to bypass findings.

As verified on September 8, 2026, the project's plan only permits the built-in
**Sonar way** gate. Retain its 80% new-code coverage condition and all security,
reliability, maintainability, duplication, and hotspot-review conditions.
`SonarCloud Code Analysis` remains optional in branch protection while building
the coverage baseline; an imported report can therefore produce a failed gate
even when the scan job and required tests pass. A custom informational-coverage
gate is only an option if the account plan later supports it.

Review retained security findings individually against the analyzed revision.
Record the input validation, regression evidence, and threat-model limits in
the issue's disposition comment. Keep filesystem and security rules enabled;
avoid broad exclusions for findings whose existing safeguards the analyzer
does not recognize.

Prioritize tests that catch authentication, workspace-request, and terminal
lifecycle failures. Renderer coverage still includes untested components.
The standalone `cli-tools/tether-cli-hook/index.js` is analyzed by Sonar but
is outside Vitest's TS/TSX coverage suite; its uncovered lines remain visible
until it has coverage from an appropriate subprocess test suite.

## One-time cutover

The CI migration is complete. These steps document account setup for a new or
recreated project:

1. Create a SonarQube Cloud token with Execute Analysis permission for Tether.
   Add it directly as the repository Actions secret `SONAR_TOKEN` at
   <https://github.com/maxthomas95/tether/settings/secrets/actions>.
   Do not put the token in source files, chat, command arguments, or logs.
2. Assign the built-in `Sonar way` quality gate and use **Previous version**
   for new code, following the policy above. Keep Sonar optional in branch
   protection while establishing the baseline.
3. In Tether's SonarQube Cloud Administration > Analysis Method, turn Automatic
   Analysis off. CI-based and automatic analysis must not run together. The
   scanner reads `sonar-project.properties`, replacing `.sonarcloud.properties`.
4. Rerun the migration PR's CI workflow. Confirm `SonarQube scan` succeeds, the
   scanner imports `coverage/lcov.info` without unresolved paths, and Sonar's PR
   analysis matches the current PR head SHA. PR analysis reports new-code
   coverage; the main-branch scan establishes overall coverage.
5. After merging, confirm the main CI run publishes overall coverage. CI can
   also be started manually from Actions > CI > Run workflow on `main`.

The scan intentionally fails with a clear setup message if a trusted run has no
token. It does not silently pass without analyzing. Test failures prevent scan
submission. Scan submission success is not the same as a passing quality gate:
review the SonarCloud PR result separately. This migration does not add a
required Sonar check or wait for the quality gate inside the `tests` job.

Fork and Dependabot PRs still run tests and produce coverage artifacts, but skip
the authenticated scan because repository secrets are unavailable. Their merged
code is scanned on main. Keep `pull_request` events; do not switch to
`pull_request_target` to expose secrets to PR code. If requiring Sonar checks in
the future, first decide how those PRs will be handled.

Once the baseline is understood, revisit making the Sonar gate required.
Coverage shows execution, not assertion quality or end-to-end Electron behavior.

## Temporary analyzer workaround

The scan step has a five-minute timeout (ten minutes for the entire scan job).
To collect file-level diagnostic logs, set the repository Actions variable
`SONAR_VERBOSE` to `true` and rerun the job; remove it afterward for normal logs.

The CI migration exposed a SonarJasmin (`JsSecuritySensorV2`) stall at
`src/renderer/index.tsx`. Normal JS/TS analysis and LCOV import had already
completed. A verbose rerun identified that file as the stalled analysis unit.
It contains font/style imports and the React root mount; application behavior
lives in `App.tsx` and the component tree.

The scanner temporarily excludes only this bootstrap file. This means Sonar
does not inspect or report coverage for those 31 lines; Vitest still includes
them in its local and CI coverage report. `App.tsx`, renderer components, and
the rest of the application remain in scope with the new security engine
enabled. Remove the exclusion and rerun the bounded scan when the upstream
analyzer can handle the entry point. See the
[similar Sonar report](https://community.sonarsource.com/t/jssecuritysensorv2-jasmin-never-terminates-on-a-single-file-ci-analysis-runs-until-the-6h-github/187475).

If cutover fails, re-enable Automatic Analysis only after disabling CI scans,
and restore `.sonarcloud.properties` from the parent of the migration commit.

References: [Sonar's JS/TS coverage setup](https://docs.sonarsource.com/sonarqube-cloud/enriching/test-coverage/javascript-typescript-test-coverage),
[official scan action](https://github.com/SonarSource/sonarqube-scan-action),
[Vitest coverage](https://vitest.dev/guide/coverage.html).
