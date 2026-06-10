# Releasing Tether

This document is the source of truth for how Tether releases are cut. All conventions here are also enforced by `scripts/release.mjs` — running the script is the recommended path; this doc explains what it does and why.

For the additional 1.0 hardening gate, see `docs/1.0_RELEASE_CHECKLIST.md`.

## Quick start

Cut a stable release (always bumps minor, e.g. `0.5.2` → `0.6.0`):

```bash
npm run release -- stable
```

Cut a beta (bumps patch by default):

```bash
npm run release -- beta.1
```

Cut the next alpha (auto-picks the next number from GitHub releases):

```bash
npm run release -- --next
```

Resume a partially-cut release (e.g. after a build failure or after the PR wait timed out):

```bash
npm run release -- stable --resume
npm run release -- beta.1 --resume
```

Dry-run to see what would happen without making changes:

```bash
npm run release -- stable --dry-run
```

## How it works

`main` is ruleset-protected — direct pushes aren't allowed. The release script cuts a `release/v{version}-{prerelease}` branch, opens a PR, enables squash auto-merge, waits for the PR to land, and then tags the merged commit on `main`. Required checks (Sonar Quality Gate, CodeQL, CI) gate the release commit just like any other PR.

## Release strategy — the train model

Decided 2026-06-09, after the stable/beta channel split. Tether runs a **release train with on-demand maintenance hotfixes**:

- **`main` is the train.** Everything merges there — features and fixes alike. No long-lived develop/stable branches.
- **Betas are save points, not promises.** Cut them freely from main's tip whenever there's something to test (`npm run release -- beta.N`). They're marked pre-release, so only the beta update channel sees them. There is no cost to cutting many.
- **Stable graduates a soaked beta.** When the current beta feels solid, cut `stable` — stable users get everything at once, already tested on the beta channel. Prefer shipping stable a bit *earlier* over letting main drift far ahead of the last stable tag.
- **The hotfix bar.** A fix earns a stable hotfix **only** if it is one of:
  1. a user-visible breakage on the current stable,
  2. a security issue in the *shipped app* (dev-tooling CVEs don't count),
  3. data loss.

  Everything else rides the train and waits for the next stable — including "valuable but preventive" fixes. Don't cut opportunistic hotfixes; they ship un-soaked code to the most risk-averse channel.
- **When a hotfix is earned:** if main has no unreleased features, the script's `hotfix.N` works directly. Otherwise use the tag-based cherry-pick flow below — squash merges make each fix a single clean `git cherry-pick`.

## Conventions

### Versioning

- `package.json` `version` is plain semver: `0.6.0`. No prerelease suffix.
- **Stable** releases always bump **minor** (`0.5.2` → `0.6.0`). Every stable release is a minor bump.
- **Beta/alpha** releases bump **patch** by default (`0.5.2` → `0.5.3`). Pass `--minor` to force a minor bump.
- **Hotfix** releases bump **patch** on top of the current stable.
- Major bumps are reserved for 1.0 and beyond.

### Release channels

| Channel | Tag format | GitHub flag | When to use |
|---------|-----------|-------------|-------------|
| `stable` | `v0.6.0` | Latest Release | Graduating betas to a stable milestone |
| `beta.N` | `v0.7.0-beta.1` | Pre-release | New features for early adopters |
| `alpha.N` | `v0.7.0-alpha.1` | Pre-release | Rough builds for internal testing |
| `hotfix.N` | `v0.6.1-hotfix.1` | Latest Release | Urgent patches to the current stable. **Only via the script if `main` has nothing unreleased to stable** — otherwise see [Hotfixing stable when `main` has unreleased features](#hotfixing-stable-when-main-has-unreleased-features) |

### Git tag

- **Stable:** `v{version}` (e.g. `v0.6.0`). No suffix.
- **Pre-release:** `v{version}-{channel}.{N}` (e.g. `v0.7.0-beta.1`).
- Lightweight tag (not annotated). Points at the squash commit merged from the release PR.

### Release branch + PR

- Branch: `release/v{version}` or `release/v{version}-{prerelease}`.
- PR title: `Release v{version}` or `Release v{version}-{prerelease}`.
- Merged via squash; branch is deleted on merge.

### CHANGELOG.md

Each release adds one section to the top, under the `# Changelog — Tether` heading:

```markdown
## [0.6.0] — 2026-05-24

### New Features
- ...

### Bug Fixes
- ...
```

For pre-release channels the heading includes the suffix: `## [0.7.0-beta.1] — 2026-05-25`.

The script auto-drafts the section with placeholders and embeds commits since the previous tag as an HTML comment. Edit the draft before the PR lands — either ahead of time, or by pushing a fixup commit to the release branch while the PR is open.

### GitHub release

- `prerelease: false` for `stable` and `hotfix.*` tags (marked as "Latest Release").
- `prerelease: true` for `alpha.*` and `beta.*` tags.
- `target_commitish: "main"`.
- `name` and `tag_name` both equal the git tag.
- `body` is the matching CHANGELOG.md section, with the heading line stripped.

### Release assets

| Asset | Source | Approx size |
|---|---|---|
| `Tether-{version}-Setup.exe` | `out/make/squirrel.windows/x64/tether-{version} Setup.exe` | ~150 MB |
| `Tether-{version}-portable.zip` | `out/make/zip/win32/x64/tether-win32-x64-{version}.zip` | ~158 MB |

Asset names use the **package.json version** (e.g. `0.3.0`), not the tag suffix.

## What the script does

Twelve idempotent phases. Each phase is a no-op if its work is already done, so the script is safe to re-run after a partial failure.

| # | Phase | Action | Skip condition |
|---|---|---|---|
| 1 | preflight | on `main`, tree clean, in sync with `github/main` | `--resume` relaxes branch/cleanliness checks |
| 2 | release-branch | create/checkout `release/v{version}-{prerelease}` | branch already checked out |
| 3 | version | bump `package.json` to target version | already at target |
| 4 | pricing-refresh | fetch latest LiteLLM pricing JSON; overwrite `src/main/usage/litellm-prices.json` if changed | unchanged, network/parse failure (warning only) |
| 5 | changelog | draft CHANGELOG section if missing | section exists |
| 6 | commit-push | commit bump+pricing+changelog, push release branch to GitHub | remote branch up to date |
| 7 | pr | open PR via `gh`, enable squash auto-merge (fall back to direct squash) | PR already merged |
| 8 | wait-merge | poll until PR is merged (30 min timeout) | PR already merged |
| 9 | tag | fast-forward `main`, tag merged commit, push tag | tag exists locally + remotely |
| 10 | build | `npm run make` | both expected artifacts exist |
| 11 | assets | resolve upload names (`Tether-{version}-...`) | always runs |
| 12 | publish | create GitHub release + upload assets | release exists / asset exists |

The pricing-refresh phase is best-effort: a network or parse failure logs a warning and the release proceeds with whatever snapshot is committed. The bundled snapshot is also the offline fallback at runtime — see `src/main/usage/pricing-fetcher.ts` for the in-app refresh that runs on every launch.

If `wait-merge` times out (e.g. a required check is failing and needs attention), fix the PR, wait for it to merge, then re-run with `--resume`.

## Auth

The script prefers `gh auth token` for API auth (same creds it already uses for PR create/merge), so a green `gh auth status` is all you need. If `gh` isn't installed or hasn't logged in, it falls back to a PAT at `~/.tether/github-token` (override path with `GITHUB_TOKEN_FILE`). Either way the token needs `repo` scope.

**Never commit tokens or paste them into chat.**

## Hotfixing stable when `main` has unreleased features

The script's `hotfix.N` channel cuts its release branch **from the tip of `main`** (phase 2), same as every other channel. That is only correct when everything on `main` is shippable to stable. Once `main` carries features that have only gone out in a beta, a hotfix cut from `main` would drag those features into the stable channel.

In that situation, cut the hotfix from the **last stable tag** and cherry-pick only the commits you want:

1. **Land the fix on `main` first**, via a normal PR (squash). `main` must never miss a fix — the stable line gets a *copy*, never the original.
2. Cut the release branch from the last stable tag, not `main`:
   ```bash
   git checkout -b release/v0.6.2-hotfix.1 v0.6.1-hotfix.1
   ```
3. Cherry-pick the fix's squash commit from `main`:
   ```bash
   git cherry-pick <squash-sha>
   ```
   Every PR squash-merges to a single commit, so each fix is one clean cherry-pick. Features you don't pick simply never reach the stable line — there is nothing to exclude or revert.
4. Bump `package.json`, add the CHANGELOG section, commit as `Release v{tag}` (manual steps 2–4 below).
5. Push the branch and tag **the branch tip**, not `main`:
   ```bash
   git push -u github release/v0.6.2-hotfix.1
   git tag v0.6.2-hotfix.1 && git push github v0.6.2-hotfix.1
   ```
6. Build and publish as in the manual flow. The GitHub release targets the existing tag (`target_commitish` is ignored once the tag exists), so the release does **not** point at `main`.
7. **Never merge this branch back into `main`.** A squash PR from an old tag would diff against `main` as a mass revert of everything since that tag. The branch is a dead end by design — the fix is already on `main` from step 1. Delete the branch once the next stable supersedes it; the tag preserves the release point.

Two caveats:

- The release branch bypasses the PR checks gate (the ruleset protects `main` only). The fix itself was checked when its PR landed on `main`, but run `npx tsc --noEmit` and `npm test` on the release branch before tagging.
- `scripts/release.mjs` cannot do this yet — phase 2 hard-codes `main` as the branch base. Until the script grows a `--from <tag>` option, tag-based hotfixes are manual.

## Manual release (fallback)

If the script breaks and you need to ship anyway:

1. `git checkout -b release/v0.X.0 main`
2. `npm version 0.X.0 --no-git-tag-version`
3. Edit `CHANGELOG.md` — add a section at the top
4. `git add package.json CHANGELOG.md && git commit -m "Release v0.X.0"`
5. `git push -u github release/v0.X.0`
6. Open a PR on GitHub, wait for checks, squash-merge
7. `git checkout main && git pull github main`
8. `git tag v0.X.0 && git push github v0.X.0`
9. `npm run make`
10. Find `out/make/squirrel.windows/x64/tether-0.X.0 Setup.exe` and `out/make/zip/win32/x64/tether-win32-x64-0.X.0.zip`
11. On GitHub UI: create a release from the tag, paste the CHANGELOG section, upload the two files renamed to `Tether-0.X.0-Setup.exe` and `Tether-0.X.0-portable.zip`.

For beta releases, replace `v0.X.0` with `v0.X.0-beta.N` throughout and mark as pre-release on GitHub.
