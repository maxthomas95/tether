# Releasing Tether

This document is the source of truth for how Tether alpha releases are cut. All conventions here are also enforced by `scripts/release.mjs` — running the script is the recommended path; this doc explains what it does and why.

## Quick start

Cut the next alpha (auto-picks the next number from Gitea):

```bash
npm run release -- --next
```

Cut a specific alpha:

```bash
npm run release -- alpha.5
```

Resume a partially-cut release (e.g. after a build failure):

```bash
npm run release -- alpha.5 --resume
```

Dry-run to see what would happen without making changes:

```bash
npm run release -- alpha.5 --dry-run
```

## Conventions

### Versioning

- `package.json` `version` is plain semver: `0.1.3`. No alpha suffix.
- The patch number bumps once per alpha. Example: alpha.3 → `0.1.2`, alpha.4 → `0.1.3`, alpha.5 → `0.1.4`.
- Major/minor bumps are saved for non-alpha milestones (none yet).

### Git tag

- Format: `v{version}-alpha.{N}`. Example: `v0.1.3-alpha.4`.
- Lightweight tag (matching existing tags in this repo — not annotated).
- Always points at the "Bump to vX.Y.Z" commit.

### Release commit

Single commit per release containing both the `package.json` bump and the new `CHANGELOG.md` section. Message format:

```
Bump to v{version}, update CHANGELOG for alpha.{N}
```

### CHANGELOG.md

Each release adds one section to the top, under the `# Changelog — Tether` heading. Section format:

```markdown
## [0.1.3-alpha.4] — 2026-04-07

### New Features
- ...

### Bug Fixes
- ...

### Improvements
- ...

### Internal
- ...
```

The script auto-drafts the section with placeholders and embeds the list of commits since the previous tag as an HTML comment. Edit the draft, then re-run with `--resume`.

### Gitea release

- `prerelease: true` (always — alphas only so far)
- `target_commitish: "main"`
- `name` and `tag_name` both equal the git tag
- `body` is the matching CHANGELOG.md section, with the heading line stripped (Gitea shows the title separately)

### Release assets

Built artifacts uploaded to every release:

| Asset | Source | Approx size |
|---|---|---|
| `Tether-{version}-Setup.exe` | `out/make/squirrel.windows/x64/tether-{version} Setup.exe` | ~150 MB |
| `Tether-{version}-portable.zip` | `out/make/zip/win32/x64/tether-win32-x64-{version}.zip` | ~158 MB |

Asset names use the **package.json version** (e.g. `0.1.3`), not the tag suffix.

## What the script does

`scripts/release.mjs` runs eight idempotent phases. Each phase is a no-op if its work is already done, so the script is safe to re-run after a partial failure (use `--resume` if the working tree has the in-flight commit).

| # | Phase | Action | Skip condition |
|---|---|---|---|
| 1 | preflight | branch is `main`, tree clean, in sync with `origin/main` | `--resume` relaxes the cleanliness check |
| 2 | version | bump `package.json` to target version | already at target |
| 3 | changelog | draft CHANGELOG section if missing | section exists |
| 4 | commit+tag | commit `package.json` + `CHANGELOG.md`, lightweight tag | tag exists |
| 5 | push | `git push origin main` + `git push origin {tag}` | already pushed |
| 6 | build | `npm run make` | both expected artifacts exist |
| 7 | assets | resolve and rename to upload conventions | always runs |
| 8 | publish | create Gitea release + upload assets | release exists / asset exists |

## Auth

The script reads your Gitea PAT from a file outside the repo:

```
C:/Users/maxth/.tether/gitea-token
```

Override with `GITEA_TOKEN_FILE=/path/to/token`. The token needs `write:repository` scope (no `read:user` needed). **Never commit the token or paste it into chat.**

## Manual release (fallback)

If the script breaks and you need to ship anyway:

1. `npm version 0.1.X --no-git-tag-version`
2. Edit `CHANGELOG.md` — add a section at the top
3. `git add package.json CHANGELOG.md && git commit -m "Bump to v0.1.X, update CHANGELOG for alpha.N"`
4. `git tag v0.1.X-alpha.N`
5. `git push origin main && git push origin v0.1.X-alpha.N`
6. `npm run make`
7. Find `out/make/squirrel.windows/x64/tether-0.1.X Setup.exe` and `out/make/zip/win32/x64/tether-win32-x64-0.1.X.zip`
8. On Gitea web UI: create a new release from the tag, mark as pre-release, paste the CHANGELOG section as the body, upload the two files renamed to `Tether-0.1.X-Setup.exe` and `Tether-0.1.X-portable.zip`.
