# Releasing Tether

This document is the source of truth for how Tether releases are cut. All conventions here are also enforced by `scripts/release.mjs` — running the script is the recommended path; this doc explains what it does and why.

## Quick start

Cut the next alpha (auto-picks the next number from GitHub releases):

```bash
npm run release -- --next
```

Cut a specific alpha or beta:

```bash
npm run release -- alpha.5
npm run release -- beta.1
```

Minor version bump (e.g. `0.2.3` → `0.3.0`):

```bash
npm run release -- beta.1 --minor
```

Resume a partially-cut release (e.g. after a build failure or after the PR wait timed out):

```bash
npm run release -- alpha.5 --resume
```

Dry-run to see what would happen without making changes:

```bash
npm run release -- alpha.5 --dry-run
```

## How it works

`main` is ruleset-protected — direct pushes aren't allowed. The release script cuts a `release/v{version}-{prerelease}` branch, opens a PR, enables squash auto-merge, waits for the PR to land, and then tags the merged commit on `main`. Required checks (Sonar Quality Gate, CodeQL, CI) gate the release commit just like any other PR.

## Conventions

### Versioning

- `package.json` `version` is plain semver: `0.3.0`. No prerelease suffix.
- Default bump per release is **patch** (`0.2.3` → `0.2.4`). Pass `--minor` for a minor bump (`0.2.3` → `0.3.0`) when a release marks a notable milestone.
- Major bumps are reserved for 1.0 and beyond.

### Git tag

- Format: `v{version}-{channel}.{N}`. Example: `v0.3.0-beta.1`.
- Lightweight tag (matching existing tags — not annotated).
- Points at the squash commit merged from the release PR.

### Release branch + PR

- Branch: `release/v{version}-{prerelease}` (e.g. `release/v0.3.0-beta.1`).
- PR title: `Release v{version}-{prerelease}`.
- Merged via squash; branch is deleted on merge.

### CHANGELOG.md

Each release adds one section to the top, under the `# Changelog — Tether` heading:

```markdown
## [0.3.0-beta.1] — 2026-04-13

### New Features
- ...

### Bug Fixes
- ...
```

The script auto-drafts the section with placeholders and embeds commits since the previous tag as an HTML comment. Edit the draft before the PR lands — either ahead of time, or by pushing a fixup commit to the release branch while the PR is open.

### GitHub release

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

Eleven idempotent phases. Each phase is a no-op if its work is already done, so the script is safe to re-run after a partial failure.

| # | Phase | Action | Skip condition |
|---|---|---|---|
| 1 | preflight | on `main`, tree clean, in sync with `github/main` | `--resume` relaxes branch/cleanliness checks |
| 2 | release-branch | create/checkout `release/v{version}-{prerelease}` | branch already checked out |
| 3 | version | bump `package.json` to target version | already at target |
| 4 | changelog | draft CHANGELOG section if missing | section exists |
| 5 | commit-push | commit bump+changelog, push release branch to GitHub | remote branch up to date |
| 6 | pr | open PR via `gh`, enable squash auto-merge (fall back to direct squash) | PR already merged |
| 7 | wait-merge | poll until PR is merged (30 min timeout) | PR already merged |
| 8 | tag | fast-forward `main`, tag merged commit, push tag | tag exists locally + remotely |
| 9 | build | `npm run make` | both expected artifacts exist |
| 10 | assets | resolve upload names (`Tether-{version}-...`) | always runs |
| 11 | publish | create GitHub release + upload assets | release exists / asset exists |

If `wait-merge` times out (e.g. a required check is failing and needs attention), fix the PR, wait for it to merge, then re-run with `--resume`.

## Auth

The GitHub token is read from `~/.tether/github-token` (override with `GITHUB_TOKEN_FILE`). Needs `repo` scope. The script also shells out to `gh` for PR creation and auto-merge, so `gh auth status` must be green.

**Never commit tokens or paste them into chat.**

## Manual release (fallback)

If the script breaks and you need to ship anyway:

1. `git checkout -b release/v0.X.Y-beta.N main`
2. `npm version 0.X.Y --no-git-tag-version`
3. Edit `CHANGELOG.md` — add a section at the top
4. `git add package.json CHANGELOG.md && git commit -m "Release v0.X.Y-beta.N"`
5. `git push -u github release/v0.X.Y-beta.N`
6. Open a PR on GitHub, wait for checks, squash-merge
7. `git checkout main && git pull github main`
8. `git tag v0.X.Y-beta.N && git push github v0.X.Y-beta.N`
9. `npm run make`
10. Find `out/make/squirrel.windows/x64/tether-0.X.Y Setup.exe` and `out/make/zip/win32/x64/tether-win32-x64-0.X.Y.zip`
11. On GitHub UI: create a release from the tag, mark as pre-release, paste the CHANGELOG section, upload the two files renamed to `Tether-0.X.Y-Setup.exe` and `Tether-0.X.Y-portable.zip`.
