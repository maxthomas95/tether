# SonarQube Cloud and coverage

CI runs `npm run test:coverage` in the existing `tests` job, then uploads the
`coverage` artifact (LCOV plus browsable HTML, retained for seven days). The
separate `SonarQube scan` job imports that report into the existing
`maxthomas95_tether` project. It does not run the tests again.

Run `npm run test:coverage` locally and open `coverage/index.html` to inspect
coverage. The suite includes untested application TS/TSX files in its baseline;
tests, test helpers, and declaration files are excluded. Build scripts and the
Helm server are outside this coverage suite but remain statically analyzed.
There is no local coverage threshold. Keep the coverage provider version aligned
with Vitest when upgrading them.

## One-time cutover

Complete these account settings before merging the migration:

1. Create a SonarQube Cloud token with Execute Analysis permission for Tether.
   Add it directly as the repository Actions secret `SONAR_TOKEN` at
   <https://github.com/maxthomas95/tether/settings/secrets/actions>.
   Do not put the token in source files, chat, command arguments, or logs.
2. The project currently uses the built-in `Sonar way` quality gate, which
   includes an 80% new-code coverage condition. To begin with informational
   coverage, copy that gate to a Tether-specific gate, remove only its coverage
   condition, and assign the copy to Tether. Preserve the reliability, security,
   maintainability, duplication, and hotspot-review conditions. Do not change
   the organization default. If the plan does not allow a custom gate, retain
   the existing gate and expect coverage to affect its reported status; keep
   Sonar checks optional while establishing the baseline.
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

Once the baseline is understood, revisit a coverage condition on new code.
Coverage shows execution, not assertion quality or end-to-end Electron behavior.

If cutover fails, re-enable Automatic Analysis only after disabling CI scans,
and restore `.sonarcloud.properties` from the parent of the migration commit.

References: [Sonar's JS/TS coverage setup](https://docs.sonarsource.com/sonarqube-cloud/enriching/test-coverage/javascript-typescript-test-coverage),
[official scan action](https://github.com/SonarSource/sonarqube-scan-action),
[Vitest coverage](https://vitest.dev/guide/coverage.html).
